# exam-bank clean re-upload

필수 구조
- public/index.html
- src/index.js
- migrations/0001_init.sql
- package.json
- wrangler.jsonc

Cloudflare 배포
- Build command: 비워두기
- Deploy command: npx wrangler deploy

D1
- binding: DB
- database: exam-bank-db

주의
- GitHub 저장소를 삭제해도 Cloudflare D1 데이터베이스 exam-bank-db는 별도 자원이므로 자동 삭제되지 않습니다.
