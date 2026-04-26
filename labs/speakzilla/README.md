# 🦖 Speakzilla — Pronunciation Assessment MVP

브라우저에서 동작하는 영어 발음 평가 MVP. Azure Speech의 Pronunciation Assessment API를 호출해서 단어 단위 점수를 색상 코딩으로 보여줍니다.

## 폴더 구조

```
speakzilla/
├── index.html       # UI
├── app.js           # 로직 (Azure SDK 호출)
├── config.js        # ⚠️ Azure 키/리전 설정 (gitignore!)
├── .gitignore
└── README.md
```

## 설정 방법

### 1. Azure 키 입력

`config.js` 파일을 열어서 본인 키와 리전을 넣으세요:

```js
const AZURE_KEY = "여기에_KEY1_붙여넣기";
const AZURE_REGION = "eastus";  // 본인 리전
```

### 2. 로컬에서 실행

브라우저 마이크 권한 때문에 `file://`로는 동작하지 않을 수 있어요. 간단한 로컬 서버를 띄워야 합니다.

**방법 A: Python (가장 간단)**
```bash
cd speakzilla
python3 -m http.server 8000
```
→ 브라우저에서 `http://localhost:8000` 접속

**방법 B: Node.js**
```bash
cd speakzilla
npx serve
```

**방법 C: VSCode**
- "Live Server" 확장 설치
- `index.html` 우클릭 → "Open with Live Server"

### 3. 사용 흐름

1. 레벨 선택 (Beginner / Intermediate / Advanced)
2. **🔊 Listen** 클릭 → 원어민 발음 듣기 (브라우저 TTS)
3. **● Record** 클릭 → 마이크 권한 허용 → 문장 읽기
4. 자동으로 멈추거나 30초 후 분석 결과 표시
5. 단어 hover로 세부 점수 확인

## 색상 코딩

| 색상 | 점수 | 의미 |
|---|---|---|
| 🟢 초록 | 80~100 | 잘함 |
| 🟡 노랑 | 60~79 | 괜찮음 |
| 🔴 빨강 | 0~59 | 더 연습 필요 |
| 🟣 보라 (취소선) | - | Omission / Insertion (빠뜨림 / 추가) |

## 점수 의미

- **Pronunciation**: 종합 점수 (Accuracy + Fluency + Completeness + Prosody 가중평균)
- **Accuracy**: 음소 정확도
- **Fluency**: 유창성 (단어 사이 자연스러운 끊어 읽기)
- **Prosody**: 운율 (강세, 억양, 속도, 리듬) — `en-US`만 지원

## 디버깅

문제가 있으면 결과 카드 하단의 "Show raw API response (debug)"를 펼쳐서 Azure가 보낸 원본 JSON 확인.

## 주의사항

- `config.js`의 키는 **브라우저에 그대로 노출**됩니다. 로컬 테스트만 OK. 배포 시에는 백엔드 토큰 발급 방식으로 바꿔야 함.
- 무료 티어(F0)는 월 5시간 제한.
- 마이크 권한이 필요. 첫 녹음 시 브라우저가 권한 요청.
- HTTPS 또는 localhost에서만 마이크 동작.

## 다음 단계 아이디어

- [ ] LLM 기반 한국어 피드백 (왜 틀렸는지 해설)
- [ ] 음소(phoneme) 단위 색상 코딩
- [ ] 피치 곡선 시각화 (Prosody)
- [ ] 사용자별 약점 음소 추적
- [ ] 매일 새로운 문장 자동 생성 (LLM)
- [ ] Azure TTS로 더 자연스러운 원어민 음성
