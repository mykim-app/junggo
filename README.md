# 중고 시세 조회

제품명을 입력하면 번개장터의 현재 중고 매물 가격(중간값·가격대·분포)과 네이버 쇼핑 새 제품 가격을 함께 보여 주는 사이트입니다.

- 화면: GitHub Pages (`index.html`)
- 자료 조회: Supabase Edge Function (`supabase/functions/price/index.ts`)
- 저장소 예시: `mykim-app/junggo` → 게시 주소 `https://mykim-app.github.io/junggo/`

## 1. 네이버 검색 API 키 발급

1. 네이버 개발자센터(developers.naver.com) → Application → 애플리케이션 등록
2. 사용 API: **검색** 선택
3. 환경: **WEB 설정** → 웹 서비스 URL에 `https://mykim-app.github.io` 입력
4. 발급된 **Client ID**, **Client Secret** 보관 (하루 25,000회까지 무료)

## 2. Supabase 함수 배포

기존 프로젝트(통관 조회 사이트와 같은 프로젝트)를 그대로 써도 됩니다.

```bash
# 저장소 폴더에서
supabase secrets set NAVER_CLIENT_ID=발급받은ID NAVER_CLIENT_SECRET=발급받은Secret
supabase secrets set ALLOWED_ORIGIN=https://mykim-app.github.io

supabase functions deploy price --no-verify-jwt
```

배포 후 브라우저에서 아래 주소가 JSON으로 나오면 정상입니다.

```
https://프로젝트ID.supabase.co/functions/v1/price?q=아이패드 에어5
```

## 3. 화면 연결 및 게시

1. `index.html`에서 `FUNCTION_URL` 한 줄을 위 함수 주소(`.../functions/v1/price`)로 수정
2. GitHub 저장소에 올린 뒤 Settings → Pages → Branch `main` / `/(root)` 저장
3. `https://mykim-app.github.io/junggo/?q=제품명` 형태로 바로 조회 링크도 쓸 수 있음

## 계산 방식

- 번개장터 검색 결과 최대 100건 중 광고, 판매완료, 구매 희망·매입·부품·고장 글, 검색어가 제목에 모두 들어 있지 않은 글, 형식적인 가격(1,111,111원 등)을 제외
- 남은 가격에서 사분위 범위(IQR) 기준으로 지나치게 높거나 낮은 가격을 추가로 제외한 뒤 중간값·가격대(하위 25%~상위 25%)·평균 계산
- 네이버는 새 상품만(중고·단종·판매예정 제외) 보고, 케이스·필름 같은 액세서리가 섞이지 않도록 중간값의 40% 미만 가격은 제외
- "새 제품 대비 %"는 중고 중간값 ÷ 새 제품 중간값

## 유의사항

- 번개장터는 공식 공개 API가 아니므로, 번개장터 측에서 응답 형식을 바꾸거나 접근을 막으면 중고 시세가 나오지 않을 수 있습니다. 이 경우에도 네이버 새 제품 가격은 계속 표시됩니다. 개인 참고용으로만 쓰는 것을 전제로 합니다.
- 결과가 엉뚱하면 검색어를 구체적으로(용량·모델명 포함) 쓰거나 "제외할 단어"에 `프로, 케이스, 펜슬` 등을 넣으면 정확해집니다.
- 조회 결과는 10분간 캐시됩니다.
