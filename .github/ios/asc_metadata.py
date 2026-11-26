#!/usr/bin/env python3
"""App Store Connect: fill the 1.0 version page (text, screenshots, build, review notes, price).

Runs in GitHub Actions with the API key secrets. Does NOT submit for review.
Age rating and App Privacy are answered in the website (not in the public API).
"""
import hashlib, json, os, sys, time, glob
import jwt, requests

APP_ID = "6839452283"
BUILD_NO = os.environ.get("BUILD_NO", "")          # empty = newest processed build
HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.appstoreconnect.apple.com/v1"

with open(os.environ["KEY"]) as f:
    PRIVATE = f.read()

def token():
    now = int(time.time())
    return jwt.encode({"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 1100,
                       "aud": "appstoreconnect-v1"}, PRIVATE, algorithm="ES256",
                      headers={"kid": os.environ["ASC_KEY_ID"], "typ": "JWT"})

def call(method, path, body=None, params=None, ok=(200, 201, 204)):
    url = path if path.startswith("http") else API + path
    r = requests.request(method, url, params=params, json=body,
                         headers={"Authorization": "Bearer " + token()})
    if r.status_code not in ok:
        print(f"!! {method} {path} -> {r.status_code}\n{r.text[:1500]}")
        raise SystemExit(1)
    return r.json() if r.text else {}

def step(t): print(f"\n== {t}", flush=True)

DESCRIPTION = """드럼 치면서 악보 넘기기 힘드셨죠?
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

드럼 학원 원장이 수업에 쓰려고 직접 만든 앱이에요."""

KEYWORDS = "드럼,악보,드럼악보,악보넘기기,메트로놈,드럼연습,MusicXML,PDF악보,드럼레슨,커버"
PROMO = "악보를 열고 노래를 붙이면, 악보가 노래를 따라 알아서 넘어가요."
SUPPORT = "https://wtg12342-hue.github.io/jdm-score/"
PRIVACY = "https://wtg12342-hue.github.io/jdm-score/privacy.html"
SUBTITLE = "노래에 맞춰 넘어가는 드럼 악보"

NOTES = """JDM Score Player is a practice tool for drummers. It reads a drum score (PDF or MusicXML),
finds the bars and beats, and follows along with a song so the drummer does not have to turn pages.

How to test (no login needed):
1. Close the short how-to slides (X) or tap through them.
2. On the start screen tap "예시 악보로 둘러보기" (Try the sample score).
3. Tap the play button. The score follows bar by bar with the metronome; the count-in is also felt as haptics.
4. Optional: tap "유튜브에서 노래 찾기" to pick a song. Videos play in the official YouTube embedded player
   (IFrame Player API); search uses the official YouTube Data API v3. Nothing from YouTube is downloaded or recorded.
5. Optional: open a PDF or MusicXML file from the Files app with "Open in JDM 악보".

iOS-specific features: opening scores from Files / Share sheet, haptic count-in, screen kept awake while playing,
playback with the silent switch on, iPad split view and two-page layout.
The app has no accounts, no ads, no purchases and no links to external purchases.
"JDM 드럼 스튜디오" and "드럼 강의" link to the developer's in-person drum school (a physical service)."""

CONTACT = dict(contactFirstName=os.environ.get("C_FIRST", ""), contactLastName=os.environ.get("C_LAST", ""),
               contactPhone=os.environ.get("C_PHONE", ""), contactEmail=os.environ.get("C_EMAIL", ""))

# ---------------------------------------------------------------- version
step("version 1.0")
vs = call("GET", f"/apps/{APP_ID}/appStoreVersions", params={"filter[platform]": "IOS", "limit": 10})["data"]
ver = next((v for v in vs if v["attributes"]["appStoreState"] in
            ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED")), None)
if not ver:
    print("no editable version:", [(v["attributes"]["versionString"], v["attributes"]["appStoreState"]) for v in vs]); sys.exit(1)
VID = ver["id"]; print(ver["attributes"]["versionString"], ver["attributes"]["appStoreState"])
if ver["attributes"]["versionString"] != "1.0.0":
    call("PATCH", f"/appStoreVersions/{VID}", {"data": {"type": "appStoreVersions", "id": VID,
         "attributes": {"versionString": "1.0.0"}}})
call("PATCH", f"/appStoreVersions/{VID}", {"data": {"type": "appStoreVersions", "id": VID,
     "attributes": {"copyright": "2026 JDM 드럼 스튜디오", "releaseType": "AFTER_APPROVAL"}}})

# ---------------------------------------------------------------- version text (ko)
step("description / keywords")
locs = call("GET", f"/appStoreVersions/{VID}/appStoreVersionLocalizations")["data"]
loc = next((l for l in locs if l["attributes"]["locale"] == "ko"), None)
attrs = {"description": DESCRIPTION, "keywords": KEYWORDS, "promotionalText": PROMO,
         "supportUrl": SUPPORT, "marketingUrl": SUPPORT}
if loc:
    call("PATCH", f"/appStoreVersionLocalizations/{loc['id']}",
         {"data": {"type": "appStoreVersionLocalizations", "id": loc["id"], "attributes": attrs}})
else:
    loc = call("POST", "/appStoreVersionLocalizations", {"data": {"type": "appStoreVersionLocalizations",
          "attributes": dict(attrs, locale="ko"),
          "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": VID}}}}})["data"]
LID = loc["id"]; print("ok")

# ---------------------------------------------------------------- app info: subtitle, privacy URL, category
step("subtitle / privacy policy / category")
infos = call("GET", f"/apps/{APP_ID}/appInfos")["data"]
info = next((i for i in infos if i["attributes"].get("state") not in ("READY_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_INFO")), infos[0])
IID = info["id"]
ilocs = call("GET", f"/appInfos/{IID}/appInfoLocalizations")["data"]
iloc = next((l for l in ilocs if l["attributes"]["locale"] == "ko"), None)
ia = {"name": "JDM 악보 플레이어", "subtitle": SUBTITLE, "privacyPolicyUrl": PRIVACY}
if iloc:
    call("PATCH", f"/appInfoLocalizations/{iloc['id']}", {"data": {"type": "appInfoLocalizations", "id": iloc["id"], "attributes": ia}})
else:
    call("POST", "/appInfoLocalizations", {"data": {"type": "appInfoLocalizations", "attributes": dict(ia, locale="ko"),
         "relationships": {"appInfo": {"data": {"type": "appInfos", "id": IID}}}}})
call("PATCH", f"/appInfos/{IID}", {"data": {"type": "appInfos", "id": IID, "relationships": {
     "primaryCategory": {"data": {"type": "appCategories", "id": "MUSIC"}},
     "secondaryCategory": {"data": {"type": "appCategories", "id": "EDUCATION"}}}}})
print("ok")

# ---------------------------------------------------------------- build
step("attach build")
params = {"filter[app]": APP_ID, "filter[processingState]": "VALID", "sort": "-uploadedDate", "limit": 5}
if BUILD_NO: params["filter[version]"] = BUILD_NO
builds = call("GET", "/builds", params=params)["data"]
if not builds:
    print("no processed build yet (still processing?)"); sys.exit(1)
b = builds[0]; print("build", b["attributes"]["version"])
call("PATCH", f"/appStoreVersions/{VID}/relationships/build", {"data": {"type": "builds", "id": b["id"]}})

# ---------------------------------------------------------------- review notes
step("review notes")
rd = call("GET", f"/appStoreVersions/{VID}/appStoreReviewDetail", ok=(200, 404))
ra = dict(CONTACT, notes=NOTES, demoAccountRequired=False)
ra = {k: v for k, v in ra.items() if v != ""}
if rd.get("data"):
    call("PATCH", f"/appStoreReviewDetails/{rd['data']['id']}", {"data": {"type": "appStoreReviewDetails", "id": rd["data"]["id"], "attributes": ra}})
else:
    call("POST", "/appStoreReviewDetails", {"data": {"type": "appStoreReviewDetails", "attributes": ra,
         "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": VID}}}}})
print("ok")

# ---------------------------------------------------------------- screenshots
def upload_set(display, files):
    sets = call("GET", f"/appStoreVersionLocalizations/{LID}/appScreenshotSets")["data"]
    s = next((x for x in sets if x["attributes"]["screenshotDisplayType"] == display), None)
    if s:  # start clean so re-runs don't pile up duplicates
        for shot in call("GET", f"/appScreenshotSets/{s['id']}/appScreenshots")["data"]:
            call("DELETE", f"/appScreenshots/{shot['id']}")
    else:
        s = call("POST", "/appScreenshotSets", {"data": {"type": "appScreenshotSets",
                 "attributes": {"screenshotDisplayType": display},
                 "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": LID}}}}})["data"]
    for fn in files:
        data = open(fn, "rb").read()
        shot = call("POST", "/appScreenshots", {"data": {"type": "appScreenshots",
                    "attributes": {"fileName": os.path.basename(fn), "fileSize": len(data)},
                    "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": s["id"]}}}}})["data"]
        for op in shot["attributes"]["uploadOperations"]:
            part = data[op["offset"]: op["offset"] + op["length"]]
            h = {x["name"]: x["value"] for x in op.get("requestHeaders", [])}
            r = requests.request(op["method"], op["url"], headers=h, data=part)
            if r.status_code >= 300: print("upload part failed", r.status_code, r.text[:300]); sys.exit(1)
        call("PATCH", f"/appScreenshots/{shot['id']}", {"data": {"type": "appScreenshots", "id": shot["id"],
             "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
        print("  uploaded", os.path.basename(fn))

step("screenshots")
store = os.path.join(HERE, "store")
upload_set("APP_IPHONE_67", sorted(glob.glob(os.path.join(store, "iphone-*.png"))))
upload_set("APP_IPAD_PRO_3GEN_129", sorted(glob.glob(os.path.join(store, "ipad-*.png"))))

# ---------------------------------------------------------------- price: free
step("price: free")
try:
    pts = call("GET", f"/apps/{APP_ID}/appPricePoints", params={"filter[territory]": "USA", "limit": 200})["data"]
    free = next(p for p in pts if float(p["attributes"]["customerPrice"]) == 0)
    call("POST", "/appPriceSchedules", {"data": {"type": "appPriceSchedules", "relationships": {
        "app": {"data": {"type": "apps", "id": APP_ID}},
        "baseTerritory": {"data": {"type": "territories", "id": "USA"}},
        "manualPrices": {"data": [{"type": "appPrices", "id": "${p0}"}]}}},
        "included": [{"type": "appPrices", "id": "${p0}", "attributes": {"startDate": None},
                      "relationships": {"appPricePoint": {"data": {"type": "appPricePoints", "id": free["id"]}}}}]})
    print("ok")
except SystemExit:
    print("price not set by API — set 무료 in the website")

print("\nDONE. Still in the website: 연령 등급, 앱 개인정보 보호, then 심사에 추가.")
