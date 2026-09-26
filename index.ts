// 중고 시세 조회 함수 (Supabase Edge Function)
// - 번개장터: 현재 올라온 중고 매물 가격을 모아 광고·구매글·극단값을 빼고 집계
// - 네이버 쇼핑 검색 API: 새 제품 가격(최저가·중간값) 참고
// 호출: GET /functions/v1/price?q=아이패드 에어5&ex=키보드,펜슬

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const NAVER_ID = Deno.env.get("NAVER_CLIENT_ID") ?? "";
const NAVER_SECRET = Deno.env.get("NAVER_CLIENT_SECRET") ?? "";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// 판매 글이 아닌 것(구매·매입·부품 등)을 거르는 단어
const NOT_FOR_SALE = [
  "삽니다", "삽니당", "구해요", "구합니다", "구매합니다", "구매해요", "매입", "사요",
  "부품", "고장", "파손", "잠김", "교환", "대여", "렌탈", "분실", "케이스만", "박스만", "액정만", "한쪽", "왼쪽", "오른쪽",
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
const tokens = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

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

// ---------- 번개장터 ----------
async function fetchBunjang(q: string, exclude: string[]) {
  const url = `https://api.bunjang.co.kr/api/1/find_v2.json?q=${encodeURIComponent(q)}&order=score&page=0&n=100`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`번개장터 응답 오류 (${res.status})`);
  const data = await res.json();
  const list: any[] = Array.isArray(data?.list) ? data.list : [];

  const qTokens = tokens(q);
  const banned = [...NOT_FOR_SALE, ...exclude].map(norm).filter(Boolean);

  const candidates = list.filter((x) => {
    if (x?.type !== "PRODUCT" || x.ad) return false;
    if (!["0", "1"].includes(String(x.status))) return false; // 0 판매중, 1 예약중
    if (String(x.used) === "2") return false; // 구매 희망 글
    const price = Number(x.price);
    if (!Number.isFinite(price) || price < 1000 || price > 50_000_000 || isDummyPrice(price)) return false;
    const name = norm(String(x.name ?? ""));
    if (!qTokens.every((t) => name.includes(t))) return false; // 검색어가 모두 제목에 있어야 함
    if (banned.some((b) => name.includes(b))) return false;
    return true;
  });

  const { kept, low, high } = trimOutliers(candidates.map((x) => Number(x.price)));
  const inRange = candidates.filter((x) => Number(x.price) >= low && Number(x.price) <= high);

  return {
    source: "번개장터",
    searched: list.length,
    totalFound: Number(data?.num_found ?? 0),
    excludedOutliers: candidates.length - kept.length,
    stats: summarize(kept),
    prices: kept,
    items: inRange.slice(0, 12).map((x) => ({
      title: String(x.name),
      price: Number(x.price),
      reserved: String(x.status) === "1",
      location: x.location ?? "",
      updated: Number(x.update_time ?? 0) * 1000,
      image: String(x.product_image ?? "").replace("{cnt}", "1").replace("{res}", "300"),
      link: `https://m.bunjang.co.kr/products/${x.pid}`,
    })),
  };
}

// ---------- 네이버 쇼핑 ----------
async function fetchNaver(q: string, exclude: string[]) {
  if (!NAVER_ID || !NAVER_SECRET) throw new Error("네이버 API 키가 설정되지 않았습니다");
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(q)}&display=50&sort=sim`;
  const res = await fetch(url, {
    headers: { "X-Naver-Client-Id": NAVER_ID, "X-Naver-Client-Secret": NAVER_SECRET },
  });
  if (!res.ok) throw new Error(`네이버 응답 오류 (${res.status})`);
  const data = await res.json();
  const list: any[] = Array.isArray(data?.items) ? data.items : [];

  const qTokens = tokens(q);
  const banned = ["중고", "리퍼", ...exclude].map(norm).filter(Boolean);

  // productType 1~3: 일반 새 상품 (4~6 중고, 7~9 단종, 10~12 판매예정)
  let items = list
    .map((x) => ({
      title: stripTags(String(x.title ?? "")),
      price: Number(x.lprice),
      mall: String(x.mallName ?? ""),
      type: Number(x.productType),
      image: String(x.image ?? ""),
      link: String(x.link ?? ""),
    }))
    .filter((x) => x.type >= 1 && x.type <= 3 && x.price > 0)
    .filter((x) => qTokens.every((t) => norm(x.title).includes(t)))
    .filter((x) => !banned.some((b) => norm(x.title).includes(b)));

  // 케이스·필름 같은 액세서리는 대개 본품보다 훨씬 싸므로 중간값의 40% 미만은 제외
  const roughMedian = quantile(items.map((x) => x.price).sort((a, b) => a - b), 0.5);
  items = items.filter((x) => x.price >= roughMedian * 0.4);

  const { kept } = trimOutliers(items.map((x) => x.price));
  return {
    source: "네이버 쇼핑",
    searched: list.length,
    stats: summarize(kept),
    items: [...items].sort((a, b) => a.price - b.price).slice(0, 5)
      .map(({ type: _t, ...rest }) => rest),
  };
}

Deno.serve(async (req) => {
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

  const [bj, nv] = await Promise.allSettled([fetchBunjang(q, exclude), fetchNaver(q, exclude)]);
  const used = bj.status === "fulfilled" ? bj.value : { error: String(bj.reason?.message ?? bj.reason) };
  const fresh = nv.status === "fulfilled" ? nv.value : { error: String(nv.reason?.message ?? nv.reason) };

  let ratio: number | null = null;
  if ("stats" in used && "stats" in fresh && used.stats.count && fresh.stats.count && fresh.stats.median) {
    ratio = Math.round((used.stats.median / fresh.stats.median) * 100);
  }

  return json({ query: q, exclude, checkedAt: new Date().toISOString(), used, new: fresh, ratio });
});
