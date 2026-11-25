# JDM 악보 플레이어 — 애플 앱스토어 준비물

## 정해 둔 값
| 항목 | 값 |
|---|---|
| 앱 이름 | JDM 악보 플레이어 |
| 부제 (30자) | 노래에 맞춰 넘어가는 드럼 악보 |
| 번들 ID | kr.jdmstudio.scoreplayer (안드로이드와 같음, 못 바꿈) |
| SKU | jdm-score-ios |
| 기본 언어 | 한국어 |
| 카테고리 | 음악 (보조: 교육) |
| 가격 | 무료 |
| 연령 등급 | 4+ (설문 전부 "없음") |
| 지원 기기 | iPhone, iPad (iOS 16 이상) |
| 개인정보처리방침 | https://wtg12342-hue.github.io/jdm-score/privacy.html |
| 지원 URL | https://wtg12342-hue.github.io/jdm-score/ |

## 스크린샷 (store 폴더)
- iPhone 6.9인치 (1320×2868): iphone-1-home.png, iphone-2-score.png
- iPad 13인치 (2064×2752): ipad-1-home.png, ipad-2-score.png

## 앱 개인정보 (App Store Connect → 앱 개인정보 보호)
- "데이터를 수집하나요?" → **아니요, 수집하지 않음**
- 이유: 회원가입·광고·분석 도구 없음. 악보·음원·저장한 곡은 기기 안에만 있음.

## 수출 규정
- 암호화: 표준 HTTPS만 사용 → Info.plist에 `ITSAppUsesNonExemptEncryption = NO` 넣어 둠 (질문 안 나옴)

## 키워드 (100자)
드럼,악보,드럼악보,악보넘기기,메트로놈,드럼연습,MusicXML,PDF악보,드럼레슨,커버

## 설명
드럼 치면서 악보 넘기기 힘드셨죠?
JDM 악보 플레이어는 악보를 읽고, 지금 치는 마디를 따라가며 알아서 넘겨 줘요.

■ 이런 걸 해요
• PDF·MusicXML 악보를 열면 마디와 박자표를 자동으로 읽어요
• 음원 파일이나 유튜브 영상에 맞춰 악보가 따라가요
• 도돌이표, 박자 변화도 그대로 따라가요
• 메트로놈, 예비박(진동으로도 알려 줘요), 구간 반복, 속도 조절
• 파일 앱이나 공유하기에서 "JDM 악보"로 바로 열기
• 연주 중에는 화면이 꺼지지 않아요, 무음 모드에서도 소리가 나요
• 아이패드 큰 화면에서 두 장 보기

■ 이런 분께
• 드럼을 배우는 학생, 레슨하는 선생님, 커버 연습하는 분

■ 안심하세요
• 회원가입 없음, 광고 없음
• 악보와 음원은 내 기기 밖으로 나가지 않아요

드럼 학원 원장이 수업에 쓰려고 직접 만든 앱이에요.

## 심사 메모 (App Review Information → Notes, 영어로)
```
JDM Score Player is a practice tool for drummers. It reads a drum score (PDF or MusicXML),
finds the bars and beats, and follows along with a song so the drummer does not have to turn pages.

How to test (no login needed):
1. On the start screen tap "예시 악보로 둘러보기" (Try the sample score).
2. Tap the play button. The score scrolls bar by bar with the metronome; the count-in is also felt as haptics.
3. Optional: tap "유튜브에서 노래 찾기" to pick a song. Videos play in the official YouTube embedded player
   (IFrame Player API); search uses the official YouTube Data API v3. Nothing from YouTube is downloaded or recorded.
4. Optional: open a PDF or MusicXML file from the Files app with "Open in JDM 악보".

iOS-specific features: opening scores from Files / Share sheet, haptic count-in, screen kept awake while playing,
playback with the silent switch on, iPad split view and two-page layout.
The app has no accounts, no ads, no purchases and no links to external purchases.
"JDM 드럼 스튜디오" is the developer's in-person drum school (a physical service).
Contact: wtg9698@naver.com
```

## App Store Connect API 키 → GitHub Secrets (원장님이 직접)
1. appstoreconnect.apple.com → **사용자 및 액세스** → 위 탭 **통합** → 왼쪽 **App Store Connect API** → **팀 키**
2. (처음이면 "API 접근 요청" → 동의) → **+** (API 키 생성)
3. 이름: `github-ios`, 접근: **앱 관리(App Manager)** → **생성**
4. 표 위쪽의 **Issuer ID**를 복사해 둠, 새 줄의 **키 ID**도 복사
5. 그 줄의 **API 키 다운로드** → `AuthKey_키ID.p8` 저장 (**한 번만 받을 수 있어요**, 잘 보관)
6. GitHub → jdm-score 저장소 → **Settings → Secrets and variables → Actions → New repository secret** 를 3번:
   - `ASC_KEY_ID` = 키 ID
   - `ASC_ISSUER_ID` = Issuer ID
   - `ASC_KEY_P8` = .p8 파일을 메모장으로 열어서 **전체 내용**(BEGIN~END 줄 포함) 붙여넣기

## TestFlight 올리기
GitHub → **Actions → ios → Run workflow** (TestFlight에 올리기 체크) → 끝나면 10~30분 뒤 TestFlight에 빌드가 보여요.
빌드 번호는 실행 번호로 자동으로 올라가요. 버전(1.0.0)은 project.yml의 MARKETING_VERSION.
