// 중고 시세 조회 함수 (Supabase Edge Function)
// - 번개장터: 현재 올라온 중고 매물 가격을 모아 광고·구매글·극단값을 빼고 집계
// - 번개장터 거래완료: 최근 30일(기본) 판매완료 글로 실거래 평균·중간값 집계
// - 당근마켓: 지정한 동네(기본 인천 연수구 송도동) 주변 매물을 같은 기준으로 집계
// - 다나와: 새 제품 최저가 참고 (네이버 쇼핑 검색 API는 2026-07-31 종료)
// 호출: GET /functions/v1/price?q=아이패드 에어5&ex=키보드,펜슬

// 호출 허용 주소 (도메인까지만, 여러 개는 쉼표로 구분). 기존 unipass 함수와 같은 Secret을 함께 씀
const ALLOWED = (Deno.env.get("ALLOWED_ORIGIN") ?? "https://mykim-app.github.io")
  .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
// 당근 검색 기준 동네: "동이름-지역번호" (기본 송도동)
const DAANGN_REGION = Deno.env.get("DAANGN_REGION") ?? "송도동-6543";
// 당근을 다른 서버(중계)를 거쳐 조회하고 싶을 때만 사용
// (선택) 설정값: DAANGN_PROXY_URL=중계 주소, DAANGN_PROXY_KEY=중계 인증값. 비워 두면 Supabase가 직접 조회
const DAANGN_PROXY_URL = (Deno.env.get("DAANGN_PROXY_URL") ?? "").replace(/\/$/, "");
const DAANGN_PROXY_KEY = Deno.env.get("DAANGN_PROXY_KEY") ?? "";

const corsFor = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && ALLOWED.includes(origin) ? origin : ALLOWED[0],
  "Vary": "Origin",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-region",
});

// 판매 글이 아닌 것(구매·매입·부품 등)을 거르는 단어
const NOT_FOR_SALE = [
  "삽니다", "삽니당", "구매)", "[구매]", "구해요", "구합니다", "구매합니다", "구매해요", "매입", "사요",
  "부품", "고장", "파손", "잠김", "교환", "대여", "렌탈", "분실", "케이스만", "박스만", "액정만", "한쪽", "왼쪽", "오른쪽",
];

// 본품이 아닌 액세서리 글에 흔한 단어 (검색어에 들어 있으면 적용하지 않음)
const ACCESSORY = ["케이스", "필름", "강화유리", "커버", "폴리오", "파우치", "상자", "키보드", "거치대", "스킨", "펜슬팁", "스트랩", "충전기", "케이블", "밴드", "충전독", "보호필름", "액정보호"];
// 본품과 함께 파는 묶음 표시 (이 표시가 있으면 액세서리 단어가 있어도 유지)
const BUNDLE = ["+", "&", "포함", "세트"];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

// 검색어 조각이 제목에 들어 있는지 검사. 숫자로 끝나거나 시작하면 앞뒤에 다른 숫자가 붙으면 안 됨
// 예: "워치2"는 "갤럭시워치2"에는 맞지만 "워치20mm"·"워치8"에는 맞지 않음
function tokenAt(name: string, token: string): boolean {
  let from = 0;
  while (true) {
    const i = name.indexOf(token, from);
    if (i < 0) return false;
    const before = name[i - 1] ?? "", after = name[i + token.length] ?? "";
    const okEnd = !/\d$/.test(token) || !/\d/.test(after);
    const okStart = !/^\d/.test(token) || !/\d/.test(before);
    if (okEnd && okStart) return true;
    from = i + 1;
  }
}
// 제목을 띄어쓰기 유지형과 붙여쓰기형 두 가지로 검사 ("아이폰15 256GB"의 15, "에어 5세대"의 에어5 모두 인식)
function hasToken(title: string, token: string): boolean {
  const spaced = title.toLowerCase().replace(/\s+/g, " ");
  return tokenAt(spaced, token) || tokenAt(norm(title), token);
}
const tokens = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}

// 1111111, 9999999 같은 형식적인 가격 제외
function isDummyPrice(n: number): boolean {
  const s = String(n);
  return /^(\d)\1{3,}$/.test(s) || s === "123456" || s === "1234567" || s === "12345678";
}

// 사분위 범위(IQR)로 극단값 제외
function trimOutliers(prices: number[]) {
  const sorted = [...prices].sort((a, b) => a - b);
  if (sorted.length < 5) return { kept: sorted, low: 0, high: Infinity };
  const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const low = q1 - 1.5 * iqr, high = q3 + 1.5 * iqr;
  return { kept: sorted.filter((p) => p >= low && p <= high), low, high };
}

function summarize(sorted: number[]) {
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    mean: sorted.length ? Math.round(sum / sorted.length / 100) * 100 : 0,
  };
}

type Listing = {
  title: string; price: number; reserved: boolean;
  location: string; updated: number; image: string; link: string;
};

// 판매 글 기준 공통 거르기: 가격 범위·형식 가격·검색어 포함·제외어
function filterListings(list: Listing[], q: string, exclude: string[]): Listing[] {
  const qTokens = tokens(q);
  const banned = [...NOT_FOR_SALE, ...exclude].map(norm).filter(Boolean);
  return list.filter((x) => {
    if (!Number.isFinite(x.price) || x.price < 1000 || x.price > 50_000_000 || isDummyPrice(x.price)) return false;
    const name = norm(x.title);
    if (!qTokens.every((t) => hasToken(x.title, t))) return false; // 검색어가 모두 제목에 있어야 함
    if (banned.some((b) => name.includes(b))) return false;
    const acc = ACCESSORY.filter((w) => !qTokens.some((t) => t.includes(w) || w.includes(t)));
    if (acc.some((w) => name.includes(w)) && !BUNDLE.some((m) => name.includes(m))) return false;
    return true;
  });
}

// 남은 액세서리·소모품 글은 본품보다 훨씬 싸므로, 상위 25% 가격의 30% 미만은 제외
function dropCheap(list: Listing[]): Listing[] {
  if (list.length < 8) return list;
  const p75 = quantile(list.map((x) => x.price).sort((a, b) => a - b), 0.75);
  return list.filter((x) => x.price >= p75 * 0.3);
}

function aggregate(source: string, filtered: Listing[], extra: Record<string, unknown> = {}) {
  const candidates = dropCheap(filtered);
  const { kept, low, high } = trimOutliers(candidates.map((x) => x.price));
  const inRange = candidates.filter((x) => x.price >= low && x.price <= high);
  return {
    source,
    ...extra,
    excludedOutliers: candidates.length - kept.length,
    stats: summarize(kept),
    prices: kept,
    candidatePrices: candidates.map((x) => x.price),
    items: [...inRange].sort((a, b) => b.updated - a.updated).slice(0, 12), // 최근 등록순
  };
}

// ---------- 번개장터 ----------
async function fetchBunjang(q: string, exclude: string[]) {
  const url = `https://api.bunjang.co.kr/api/1/find_v2.json?q=${encodeURIComponent(q)}&order=date&page=0&n=100`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`번개장터 응답 오류 (${res.status})`);
  const data = await res.json();
  const list: any[] = Array.isArray(data?.list) ? data.list : [];

  const listings: Listing[] = list
    .filter((x) => x?.type === "PRODUCT" && !x.ad)
    .filter((x) => ["0", "1"].includes(String(x.status))) // 0 판매중, 1 예약중
    .filter((x) => String(x.used) !== "2") // 구매 희망 글
    .map((x) => ({
      title: String(x.name ?? ""),
      price: Number(x.price),
      reserved: String(x.status) === "1",
      location: x.location ?? "",
      updated: Number(x.update_time ?? 0) * 1000,
      image: String(x.product_image ?? "").replace("{cnt}", "1").replace("{res}", "300"),
      link: `https://m.bunjang.co.kr/products/${x.pid}`,
    }));

  return aggregate("번개장터", filterListings(listings, q, exclude), {
    searched: list.length,
    totalFound: Number(data?.num_found ?? 0),
  });
}

// ---------- 번개장터 거래완료 (최근 N일 실거래) ----------
// f_status=3 은 판매완료 글. 최신순으로 받아 기준일 이전 글이 나오면 멈춤
// 거래 시점은 글의 마지막 변경 시각(update_time)으로 봄 (판매완료 처리 시점과 대체로 같음)
async function fetchBunjangSold(q: string, exclude: string[], days: number) {
  const cutoff = Date.now() - days * 86400000;
  const rows: any[] = [];
  for (let page = 0; page < 4; page++) {
    const url = `https://api.bunjang.co.kr/api/1/find_v2.json?q=${encodeURIComponent(q)}&order=date&page=${page}&n=100&f_status=3`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
    if (!res.ok) throw new Error(`번개장터 거래완료 응답 오류 (${res.status})`);
    const list: any[] = (await res.json())?.list ?? [];
    rows.push(...list);
    const oldest = Math.min(...list.map((x) => Number(x.update_time ?? 0) * 1000));
    if (list.length < 100 || oldest < cutoff) break;
  }

  const listings: Listing[] = rows
    .filter((x) => x?.type === "PRODUCT" && !x.ad && String(x.used) !== "2")
    .map((x) => ({
      title: String(x.name ?? ""),
      price: Number(x.price),
      reserved: false,
      location: x.location ?? "",
      updated: Number(x.update_time ?? 0) * 1000,
      image: String(x.product_image ?? "").replace("{cnt}", "1").replace("{res}", "300"),
      link: `https://m.bunjang.co.kr/products/${x.pid}`,
    }))
    .filter((x) => x.updated >= cutoff);

  const result = aggregate("번개장터 거래완료", filterListings(listings, q, exclude), {
    days,
    from: new Date(cutoff).toISOString(),
    to: new Date().toISOString(),
  });
  return result;
}

// ---------- 당근마켓 ----------
// 공식 API가 없어 웹 검색 화면에 담긴 자료(__remixContext)를 읽음
async function fetchDaangnOnce(q: string) {
  if (DAANGN_PROXY_URL) {
    const r = await fetch(`${DAANGN_PROXY_URL}/daangn?q=${encodeURIComponent(q)}&region=${encodeURIComponent(DAANGN_REGION)}`, {
      headers: { "X-Proxy-Key": DAANGN_PROXY_KEY },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`NAS 중계 응답 오류 (${r.status})`);
    const j = await r.json();
    return { region: j.region ?? DAANGN_REGION, articles: Array.isArray(j.articles) ? j.articles : [] };
  }
  const url = `https://www.daangn.com/kr/buy-sell/?in=${encodeURIComponent(DAANGN_REGION)}&search=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`당근 응답 오류 (${res.status})`);
  const html = await res.text();
  const marker = "__remixContext = ";
  const i = html.indexOf(marker);
  if (i < 0) throw new Error("당근 화면 형식이 바뀌었습니다");
  const j = html.indexOf(";</script>", i);
  const ctx = JSON.parse(html.slice(i + marker.length, j));
  const loader = ctx?.state?.loaderData ?? {};
  const route: any = Object.entries(loader).find(([k]) => k.includes("buy-sell"))?.[1] ?? {};
  return {
    region: route?.searchRegion?.fullName ?? DAANGN_REGION,
    articles: Array.isArray(route?.buySellArticles) ? route.buySellArticles : [],
  };
}

// 당근은 짧은 시간에 요청이 반복되면 같은 접속 주소에 빈 결과를 돌려줌 → 다시 시도하지 않고, 성공한 결과를 저장해 재사용
const daangnCache = new Map<string, { t: number; region: string; articles: any[] }>();
const DAANGN_FRESH_MS = 30 * 60 * 1000;      // 30분 안의 결과는 당근에 다시 묻지 않음
const DAANGN_FALLBACK_MS = 24 * 60 * 60 * 1000; // 빈 결과가 오면 24시간 안의 이전 결과로 대신 표시

async function fetchDaangn(q: string, exclude: string[]) {
  const key = `${DAANGN_REGION}|${q}`;
  const now = Date.now();
  const hit = daangnCache.get(key);
  let got: { region: string; articles: any[] };
  let fetchedAt = now;
  if (hit && now - hit.t < DAANGN_FRESH_MS) {
    got = hit; fetchedAt = hit.t;
  } else {
    got = await fetchDaangnOnce(q);
    if (got.articles.length) {
      daangnCache.set(key, { t: now, ...got });
      for (const [k, v] of daangnCache) if (now - v.t > DAANGN_FALLBACK_MS) daangnCache.delete(k);
    } else if (hit && now - hit.t < DAANGN_FALLBACK_MS) {
      got = hit; fetchedAt = hit.t;
    }
  }
  const listings: Listing[] = got.articles
    .filter((x) => ["Ongoing", "Reserved"].includes(String(x.status)))
    .map((x) => ({
      title: String(x.title ?? ""),
      price: Math.round(parseFloat(String(x.price ?? "0"))),
      reserved: String(x.status) === "Reserved",
      location: x.region?.name ?? "",
      updated: Date.parse(x.createdAt ?? x.boostedAt ?? "") || 0, // 최초 등록 시각
      image: String(x.thumbnail ?? ""),
      link: `https://www.daangn.com${x.href ?? ""}`,
    }));

  return aggregate("당근마켓", filterListings(listings, q, exclude), {
    searched: got.articles.length,
    region: got.region,
    fetchedAt: new Date(fetchedAt).toISOString(),
  });
}

// ---------- 다나와 (새 제품 최저가) ----------
// 네이버 쇼핑 검색 API가 2026-07-31 종료되어 다나와 검색 화면에서 최저가를 읽음 (인증키 불필요)
const decode = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

const EN: [string, string][] = [
  ["아이패드", "ipad"], ["아이폰", "iphone"], ["맥북", "macbook"], ["에어팟", "airpods"], ["애플워치", "applewatch"],
  ["아이맥", "imac"], ["에어", "air"], ["프로", "pro"], ["미니", "mini"], ["맥스", "max"], ["울트라", "ultra"], ["플러스", "plus"],
];
const toEnglish = (t: string) => EN.reduce((acc, [ko, en]) => acc.split(ko).join(en), t);

async function fetchDanawa(q: string, exclude: string[]) {
  const url = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9",
      Referer: "https://www.danawa.com/",
    },
  });
  if (!res.ok) throw new Error(`다나와 응답 오류 (${res.status})`);
  const html = await res.text();

  // 상품명 영역(prod_name)을 기준으로 나눠 이름·링크·첫 가격·이미지를 읽음
  const parts = html.split('class="prod_name"');
  type Item = {
    title: string; price: number; link: string; image: string; mall: string;
    lowest: number; release: number | null; discontinued: boolean; registered: string | null;
  };
  const raw: Item[] = [];
  for (let k = 1; k < parts.length; k++) {
    const seg = parts[k];
    const prev = parts[k - 1].slice(-6000);
    const liClass = [...prev.matchAll(/<li[^>]*class="([^"]*)"/g)].pop()?.[1] ?? "";
    if (/ad/i.test(liClass.replace("prod_item", ""))) continue; // 광고 상품 제외
    const m = seg.match(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const p = seg.match(/class="price_sect">[\s\S]*?<strong>([\d,]+)<\/strong>/);
    if (!m || !p) continue;
    const imgs = [...prev.matchAll(/<img[^>]+(?:data-original|src)="([^"]+)"/g)];
    let image = imgs.pop()?.[1] ?? "";
    if (image.startsWith("//")) image = "https:" + image;
    const lowest = Number(p[1].replace(/,/g, ""));
    const rel = seg.match(/출시가:\s*([\d,]+)원/);
    const release = rel ? Number(rel[1].replace(/,/g, "")) : null;
    // 다나와 등록월 (예: "22.04. 등록")
    const regM = decode(seg.slice(0, 40000)).match(/(\d{2})\.(\d{2})\.\s*등록/);
    const regDate = regM ? new Date(2000 + Number(regM[1]), Number(regM[2]) - 1, 1) : null;
    const ageMonths = regDate ? (Date.now() - regDate.getTime()) / (30.4 * 86400000) : 0;
    // 다나와는 단종 여부를 따로 표시하지 않음 → 등록 후 18개월 이상 지났고 최저가가 출시가보다 비싸면
    // 남은 재고 가격으로 보고 단종으로 추정 (신제품의 일시적 웃돈은 제외)
    const discontinued = !!release && lowest > release && ageMonths >= 18;
    raw.push({
      title: decode(m[2]),
      price: discontinued ? release! : lowest, // 단종 추정 제품은 출시가로 표시
      link: m[1].replace(/&amp;/g, "&"),
      image,
      mall: discontinued ? `출시가, 단종 추정 (현재 최저가 ${lowest.toLocaleString("ko-KR")}원)` : "다나와 최저가",
      lowest,
      release,
      discontinued,
      registered: regM ? `20${regM[1]}.${regM[2]}.` : null,
    });
  }

  // 중고·해외구매·리퍼 제외, 제외어 반영
  const banned = ["중고", "해외구매", "리퍼", "렌탈", ...exclude].map(norm).filter(Boolean);
  // 다나와는 검색어와 다른 신제품을 앞에 보여 주는 경우가 있어(예: 워치2 → 워치8) 검색어가 모두 들어 있는 상품만 사용
  // 애플 제품처럼 상품명이 영문인 경우를 위해 흔한 한글 표기는 영문으로도 맞춰 봄
  const qTokens = tokens(q);
  const acc = ACCESSORY.filter((w) => !qTokens.some((t) => t.includes(w) || w.includes(t)));
  const matches = (title: string) =>
    qTokens.every((t) => hasToken(title, t) || hasToken(title, toEnglish(t)));
  const bundleOk = q.includes("+");
  const candidates = raw.filter((x) =>
    x.price > 0 && matches(x.title) &&
    (bundleOk || !x.title.includes("+")) && // 다른 제품과 묶은 구성(예: 탭S9+버즈2)은 제외
    !banned.some((b) => norm(x.title).includes(b)) &&
    !acc.some((w) => norm(x.title).includes(w)));
  if (!candidates.length) {
    // 새 제품 판매가 없더라도(중고 상품만 남은 경우 등) 출시가가 적혀 있으면 출시가를 새 제품가로 사용
    const withRelease = raw.find((x) => x.release && matches(x.title) && !norm(x.title).includes("해외구매")
      && !acc.some((w) => norm(x.title).includes(w)));
    if (withRelease) {
      const rep = {
        ...withRelease,
        title: withRelease.title.replace(/,?\s*중고$/, ""),
        price: withRelease.release!,
        discontinued: true,
        mall: "출시가, 단종 추정 (다나와에 새 제품 판매 없음)",
      };
      return {
        source: "다나와", searched: raw.length, rep, items: [rep],
        stats: { ...summarize([rep.price]), median: rep.price, min: rep.price },
      };
    }
    return { source: "다나와", searched: raw.length, stats: summarize([]), rep: null, items: [], notFound: true };
  }

  // 본품보다 훨씬 싼 액세서리가 섞이지 않도록, 후보 가격 중간값의 30% 미만은 제외
  const midP = quantile(candidates.map((x) => x.price).sort((a, b) => a - b), 0.5);
  for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].price < midP * 0.3) candidates.splice(i, 1);

  // 검색어에 없는 파생 모델(프로·플러스·클래식 등)보다 기본 모델을 대표 제품으로 우선
  const VARIANT = ["프로", "pro", "플러스", "plus", "맥스", "max", "울트라", "ultra", "미니", "mini", "클래식", "라이트", "lite", "fe", "엣지", "edge"];
  const extra = VARIANT.filter((v) => !qTokens.some((t) => t.includes(v) || toEnglish(t).includes(v)));
  const variantCount = (title: string) => extra.filter((v) => norm(title).includes(v)).length;
  candidates.sort((a, b) => variantCount(a.title) - variantCount(b.title)); // 같은 조건이면 다나와 순서 유지

  // 다나와 검색 1순위 상품을 대표 제품으로 보고, 가격대가 비슷한(0.5~2배) 상품만 함께 표시
  const rep = candidates[0];
  const similar = candidates.filter((x) => x.price >= rep.price * 0.5 && x.price <= rep.price * 2).slice(0, 5);
  return {
    source: "다나와",
    searched: raw.length,
    rep,
    stats: { ...summarize(similar.map((x) => x.price).sort((a, b) => a - b)), median: rep.price, min: rep.price },
    items: similar,
  };
}

Deno.serve(async (req) => {
  const cors = corsFor(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const u = new URL(req.url);
  const q = (u.searchParams.get("q") ?? "").trim().slice(0, 60);
  const exclude = (u.searchParams.get("ex") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10);

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=600" },
    });

  if (!q) return json({ error: "검색어(q)를 입력하세요" }, 400);
  const days = Math.min(Math.max(Number(u.searchParams.get("days") ?? 30) || 30, 7), 90);

  const [bj, dg, nv, sd] = await Promise.allSettled([
    fetchBunjang(q, exclude), fetchDaangn(q, exclude), fetchDanawa(q, exclude), fetchBunjangSold(q, exclude, days),
  ]);
  const err = (r: PromiseRejectedResult) => ({ error: String(r.reason?.message ?? r.reason) });
  const bunjang = bj.status === "fulfilled" ? bj.value : err(bj);
  const daangn = dg.status === "fulfilled" ? dg.value : err(dg);
  const fresh = nv.status === "fulfilled" ? nv.value : err(nv);
  const sold: any = sd.status === "fulfilled" ? sd.value : err(sd);

  // 두 곳 매물을 합쳐 다시 극단값을 빼고 통합 시세 계산
  const merged = [bunjang, daangn].flatMap((s: any) => s.candidatePrices ?? []);
  const { kept } = trimOutliers(merged);
  const combined = { stats: summarize(kept) };

  let ratio: number | null = null;
  if (combined.stats.count && "stats" in fresh && fresh.stats.count && fresh.stats.median) {
    ratio = Math.round((combined.stats.median / fresh.stats.median) * 100);
  }
  let soldRatio: number | null = null;
  if (sold.stats?.count && "stats" in fresh && fresh.stats.median) {
    soldRatio = Math.round((sold.stats.mean / fresh.stats.median) * 100);
  }
  for (const s of [bunjang, daangn, sold] as any[]) delete s.candidatePrices;

  return json({ query: q, exclude, checkedAt: new Date().toISOString(), combined, bunjang, daangn, sold, new: fresh, ratio, soldRatio });
});
