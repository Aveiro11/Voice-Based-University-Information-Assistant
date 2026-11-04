"""Scrapes the programmes listed under one category on the GU master's
listing page. Per programme it saves the syllabus (pdf or html page) when
there is one, plus the text of the programme page itself.

    python scraper/scrape_programmes.py            # all programmes
    python scraper/scrape_programmes.py n2cos      # only some, by code
"""

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import pymupdf
import requests
from bs4 import BeautifulSoup

LISTING_URL = (
    "https://www.gu.se/en/study-in-gothenburg/programs-and-courses/masters-programs"
)
CATEGORY = "AI, Computer Science and Technology"

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
OUT_DIR = DATA_DIR / "programmes"
MIN_CHARS = 1500  # a syllabus shorter than this is treated as empty
HEADERS = {"User-Agent": "Mozilla/5.0 (university course project; dialogue systems)"}


class ScraperError(Exception):
    pass


def get(url: str) -> requests.Response:
    try:
        r = requests.get(url, headers=HEADERS, timeout=40)
        r.raise_for_status()
        return r
    except requests.RequestException as err:
        raise ScraperError(f"could not fetch {url}: {err}") from err


def find_programmes(listing_html: str) -> list[dict]:
    soup = BeautifulSoup(listing_html, "html.parser")
    heading = next(
        (h for h in soup.find_all(["h2", "h3"]) if h.get_text(strip=True) == CATEGORY),
        None,
    )
    if heading is None:
        raise ScraperError(f'no section called "{CATEGORY}" on the listing page')

    found: dict[str, str] = {}
    # walk forward from the heading, stop at the next category heading
    for el in heading.find_all_next(["a", "h2"]):
        if el.name == "h2":
            break
        href = el.get("href", "")
        if "/study-gothenburg/" not in href:
            continue
        name = re.sub(r"\s*\(External link\)\s*$", "", el.get_text(" ", strip=True))
        found.setdefault(urljoin(LISTING_URL, href), name)

    # the code is the last chunk of the url, e.g. ...-programme-n2cos
    return [
        {"name": n, "url": u, "code": u.rstrip("/").split("-")[-1].upper()}
        for u, n in found.items()
    ]


def element_text(root) -> str:
    for tag in root.find_all(["script", "style", "nav", "footer", "noscript"]):
        tag.decompose()
    # headings stay visible as #, ##, ### so we can split on them later
    for h in root.find_all(["h1", "h2", "h3"]):
        h.string = f"\n{'#' * int(h.name[1])} {h.get_text(' ', strip=True)}\n"
    text = root.get_text("\n", strip=True)
    return re.sub(r"\n{3,}", "\n\n", text)


def page_text(soup: BeautifulSoup) -> str:
    roots = [
        soup.find(id="main-content"),
        soup.find("main"),
        soup.find(attrs={"role": "main"}),
        soup.body,
    ]
    best = ""
    for root in roots:
        if root is None:
            continue
        text = element_text(root)
        best = max(best, text, key=len)
        if len(text) >= 500:  # a real content area, not an empty anchor
            best = text
            break

    # drop the menu in front of the page title and the footer after the content
    m = re.search(r"^# ", best, re.M)
    if m:
        best = best[m.start():]
    return re.split(r"\nContact\nThe University of Gothenburg", best)[0].strip()


def syllabus_links(soup: BeautifulSoup, page_url: str) -> list[dict]:
    """Links labelled 'Syllabus' that point to a pdf or to a /syllabus/<id>
    page. Has to run before page_text(), which edits the soup."""
    out = []
    for a in soup.find_all("a", href=True):
        if "syllabus" not in a.get_text(" ", strip=True).lower():
            continue
        url = urljoin(page_url, a["href"])
        is_pdf = ".pdf" in url.lower()
        is_page = re.search(r"/syllabus/[0-9a-f-]{20,}", url) is not None
        if not (is_pdf or is_page):
            continue
        h2 = a.find_previous("h2")  # e.g. "Autumn 2026"
        code = a.find_previous(string=re.compile(r"GU-\d{5}"))
        out.append(
            {
                "url": url,
                "format": "pdf" if is_pdf else "html",
                "intake": h2.get_text(strip=True) if h2 else None,
                "application_code": re.search(r"GU-\d{5}", code).group() if code else None,
            }
        )
    return out


def pick(links: list[dict]) -> tuple[dict, str]:
    if not links:
        raise ScraperError("no syllabus link on the programme page")

    # if the intakes point to different syllabi, the latest intake wins
    def newest(item):
        i, link = item
        year = re.search(r"20\d\d", link["intake"] or "")
        return (int(year.group()) if year else 0, i)

    best = max(enumerate(links), key=newest)[1]
    distinct = len({l["url"] for l in links})
    if distinct == 1:
        return best, "only one distinct syllabus link"
    return best, f"{distinct} different syllabus links, took the latest intake ({best['intake']})"


def pdf_to_text(path: Path) -> tuple[str, int]:
    doc = pymupdf.open(path)
    parts = [
        f"=== PAGE {i} ===\n{page.get_text().strip()}\n"
        for i, page in enumerate(doc, start=1)
    ]
    pages = len(doc)
    doc.close()
    return "\n".join(parts), pages


def fetch_syllabus(link: dict, folder: Path) -> dict:
    if link["format"] == "pdf":
        r = get(link["url"])
        if not r.content.startswith(b"%PDF"):
            raise ScraperError("the syllabus link did not return a pdf")
        (folder / "syllabus.pdf").write_bytes(r.content)
        try:
            text, pages = pdf_to_text(folder / "syllabus.pdf")
        except Exception as err:
            raise ScraperError(f"could not read the pdf: {err}") from err
    else:
        text = page_text(BeautifulSoup(get(link["url"]).text, "html.parser"))
        pages = None

    real = re.sub(r"=== PAGE \d+ ===", "", text).strip()
    if len(real) < MIN_CHARS:
        raise ScraperError(f"syllabus has only {len(real)} characters of text")
    (folder / "syllabus.txt").write_text(text, encoding="utf-8")
    return {
        "syllabus_format": link["format"],
        "syllabus_pages": pages,
        "syllabus_chars": len(text),
    }


def scrape_programme(p: dict) -> dict:
    folder = OUT_DIR / p["code"].lower()
    folder.mkdir(parents=True, exist_ok=True)
    # leftovers from an earlier run would be picked up by the ingest
    for name in ("syllabus.txt", "syllabus.pdf", "programme_page.txt"):
        (folder / name).unlink(missing_ok=True)

    soup = BeautifulSoup(get(p["url"]).text, "html.parser")
    links = syllabus_links(soup, p["url"])
    page = page_text(soup)
    if len(page) < 500:
        raise ScraperError(f"programme page text is only {len(page)} characters")
    (folder / "programme_page.txt").write_text(page, encoding="utf-8")

    info = {
        "syllabus_format": None,
        "syllabus_url": None,
        "syllabus_pages": None,
        "syllabus_chars": 0,
    }
    try:
        link, why = pick(links)
        info.update(fetch_syllabus(link, folder), syllabus_url=link["url"])
    except ScraperError as err:
        # no syllabus we can read, so the programme page alone has to do
        why = f"no syllabus saved ({err})"

    meta = {
        **p,
        **info,
        "selection_reason": why,
        "all_syllabus_links": links,
        "programme_page_chars": len(page),
        "scraped_at_utc": datetime.now(timezone.utc).isoformat(),
    }
    (folder / "metadata.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return meta


def main() -> None:
    wanted = {c.lower() for c in sys.argv[1:]}
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    programmes = find_programmes(get(LISTING_URL).text)
    print(f'found {len(programmes)} programmes under "{CATEGORY}"')

    results = []
    for p in programmes:
        if wanted and p["code"].lower() not in wanted:
            continue
        print(f"\n{p['code']}  {p['name']}")
        try:
            m = scrape_programme(p)
            if m["syllabus_format"]:
                print(f"  syllabus: {m['syllabus_format']}, {m['syllabus_chars']} chars")
                print(f"  {m['syllabus_url']}")
            else:
                print(f"  {m['selection_reason']}")
            print(f"  programme page: {m['programme_page_chars']} chars")
            status = "ok" if m["syllabus_format"] else "page_only"
            results.append({**p, "status": status, "syllabus_format": m["syllabus_format"]})
        except ScraperError as err:
            print(f"  FAILED: {err}")
            results.append({**p, "status": f"failed: {err}"})
        time.sleep(1)  # be polite to the server

    # the overview is only written after a full run
    if not wanted:
        (DATA_DIR / "category.json").write_text(
            json.dumps(
                {
                    "category": CATEGORY,
                    "listing_url": LISTING_URL,
                    "scraped_at_utc": datetime.now(timezone.utc).isoformat(),
                    "programmes": results,
                },
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

    usable = sum(r["status"] in ("ok", "page_only") for r in results)
    print(f"\n{usable}/{len(results)} programmes saved")


if __name__ == "__main__":
    try:
        main()
    except ScraperError as err:
        print(f"ERROR: {err}", file=sys.stderr)
        sys.exit(1)