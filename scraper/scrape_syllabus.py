"""
scrape_syllabus.py
------------------
Scraper for ONE page: the GU Master in Language Technology programme page.

What it does:
  1. Fetches the programme page (requests)
  2. Parses the HTML (BeautifulSoup) and finds syllabus PDF links
     in the "Curriculum" blocks (one block per intake on the page)
  3. Resolves relative URLs, removes duplicates, selects ONE PDF explicitly
  4. Downloads the PDF
  5. Extracts text page by page (PyMuPDF), keeping page markers
  6. Saves data/syllabus.pdf, data/syllabus.txt, data/metadata.json

Run (from the uni-assistant folder, with the venv active):
    python scraper/scrape_syllabus.py
    python scraper/scrape_syllabus.py <other-programme-page-url>   # optional
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import pymupdf
import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

# The programme PAGE (not the PDF). The PDF link is discovered from this page.
DEFAULT_PAGE_URL = (
    "https://www.gu.se/en/study-gothenburg/master-in-language-technology-h2ltg"
)

# data/ folder next to the scraper/ folder: uni-assistant/data
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# If extraction gives fewer characters than this, we treat the PDF as
# "no usable text" (e.g. a scanned PDF) and stop with a clear error.
MIN_TEXT_CHARS = 2000

# Some sites block the default "python-requests" user agent.
HEADERS = {"User-Agent": "Mozilla/5.0 (university course project; dialogue systems)"}


class ScraperError(Exception):
    """Raised for any expected failure so main() can print a clean message."""


# ---------------------------------------------------------------------------
# Step 1: fetch the page
# ---------------------------------------------------------------------------
def fetch_html(url: str) -> str:
    try:
        response = requests.get(url, headers=HEADERS, timeout=30)
        response.raise_for_status()  # raises on 404, 500, ...
    except requests.RequestException as err:
        raise ScraperError(f"Could not fetch the programme page: {err}") from err
    return response.text


# ---------------------------------------------------------------------------
# Step 2: find syllabus PDF links
# ---------------------------------------------------------------------------
def find_syllabus_candidates(html: str, page_url: str) -> list[dict]:
    """Return every PDF link whose text mentions 'syllabus', with metadata."""
    soup = BeautifulSoup(html, "html.parser")
    candidates = []

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        text = a.get_text(" ", strip=True)

        # Only PDF links whose visible text mentions "syllabus"
        if ".pdf" not in href.lower() or "syllabus" not in text.lower():
            continue

        # Each intake block has labels (Curriculum, Tuition, Application code).
        # The closest label above the link tells us which part we're in.
        label = a.find_previous(
            string=re.compile(r"^\s*(Curriculum|Tuition|Application code)\s*$")
        )
        in_curriculum = bool(label) and label.strip() == "Curriculum"

        # The page repeats one block per intake. The nearest previous <h2>
        # is e.g. "Autumn 2026"; the nearest previous "GU-xxxxx" string is
        # the application code of that block.
        intake_tag = a.find_previous("h2")
        code_text = a.find_previous(string=re.compile(r"GU-\d{5}"))
        code_match = re.search(r"GU-\d{5}", code_text) if code_text else None

        candidates.append(
            {
                "url": urljoin(page_url, href),  # relative -> absolute
                "link_text": text,
                "intake": intake_tag.get_text(strip=True) if intake_tag else None,
                "application_code": code_match.group(0) if code_match else None,
                "in_curriculum_section": in_curriculum,
            }
        )
    return candidates


# ---------------------------------------------------------------------------
# Step 3: pick ONE syllabus explicitly
# ---------------------------------------------------------------------------
def select_syllabus(candidates: list[dict]) -> tuple[str, str]:
    """Return (chosen_url, human-readable reason)."""
    if not candidates:
        raise ScraperError(
            "No syllabus PDF link found. The page layout may have changed."
        )

    # Prefer links that were found inside a Curriculum block.
    preferred = [c for c in candidates if c["in_curriculum_section"]] or candidates

    # Group by URL (the same PDF is linked once per intake).
    distinct_urls = list(dict.fromkeys(c["url"] for c in preferred))

    if len(distinct_urls) == 1:
        return distinct_urls[0], (
            f"Only one distinct syllabus URL found "
            f"(linked {len(preferred)}x, once per intake)."
        )

    # Several different PDFs: choose the newest by the YYYY-MM folder in the URL.
    def date_key(url: str):
        m = re.search(r"/(\d{4})-(\d{2})/", url)
        return (int(m.group(1)), int(m.group(2))) if m else (0, 0)

    chosen = max(distinct_urls, key=date_key)
    return chosen, (
        f"{len(distinct_urls)} distinct syllabus PDFs found; "
        f"chose the newest by upload folder date."
    )


# ---------------------------------------------------------------------------
# Step 4: download the PDF
# ---------------------------------------------------------------------------
def download_pdf(pdf_url: str, dest: Path) -> dict:
    try:
        response = requests.get(pdf_url, headers=HEADERS, timeout=60)
        response.raise_for_status()
    except requests.RequestException as err:
        raise ScraperError(f"Failed to download the PDF: {err}") from err

    # Every real PDF starts with the bytes "%PDF". Catches HTML error pages.
    if not response.content.startswith(b"%PDF"):
        raise ScraperError("Downloaded file is not a PDF (no %PDF header).")

    dest.write_bytes(response.content)
    return {
        "size_bytes": len(response.content),
        "last_modified_header": response.headers.get("Last-Modified"),
    }


# ---------------------------------------------------------------------------
# Step 5: extract text with PyMuPDF
# ---------------------------------------------------------------------------
def extract_text(pdf_path: Path) -> tuple[str, int]:
    """Return (text with '=== PAGE n ===' markers, page_count).

    The markers let us attach page numbers to chunks in Stage 2.
    """
    try:
        doc = pymupdf.open(pdf_path)
    except Exception as err:
        raise ScraperError(f"PyMuPDF could not open the PDF: {err}") from err

    parts = []
    for page_number, page in enumerate(doc, start=1):  # pages count from 1
        parts.append(f"=== PAGE {page_number} ===\n{page.get_text().strip()}\n")
    page_count = len(doc)
    doc.close()

    text = "\n".join(parts)
    # Don't count the markers when judging whether there is real text.
    real_chars = len(re.sub(r"=== PAGE \d+ ===", "", text).strip())
    if real_chars < MIN_TEXT_CHARS:
        raise ScraperError(
            f"Only {real_chars} characters extracted. The PDF may be scanned "
            "(image-only) and would need OCR."
        )
    return text, page_count


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    page_url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PAGE_URL
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[1/5] Fetching programme page: {page_url}")
    html = fetch_html(page_url)

    print("[2/5] Looking for syllabus PDF links ...")
    candidates = find_syllabus_candidates(html, page_url)
    for c in candidates:
        print(f"      - {c['intake']} / {c['application_code']} -> {c['url']}")

    pdf_url, reason = select_syllabus(candidates)
    print(f"[3/5] Selected: {pdf_url}\n      Reason: {reason}")

    pdf_path = DATA_DIR / "syllabus.pdf"
    print("[4/5] Downloading PDF ...")
    download_info = download_pdf(pdf_url, pdf_path)

    print("[5/5] Extracting text ...")
    text, page_count = extract_text(pdf_path)
    (DATA_DIR / "syllabus.txt").write_text(text, encoding="utf-8")

    metadata = {
        "programme_page_url": page_url,
        "programme_code": "H2LTG",
        "document_name": "H2LTG-en.pdf (programme syllabus)",
        "pdf_url": pdf_url,
        "selection_reason": reason,
        "all_candidates": candidates,
        "scraped_at_utc": datetime.now(timezone.utc).isoformat(),
        "page_count": page_count,
        "text_characters": len(text),
        **download_info,
    }
    (DATA_DIR / "metadata.json").write_text(
        json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"\nDone. {page_count} pages, {len(text)} characters. Files in: {DATA_DIR}")


if __name__ == "__main__":
    try:
        main()
    except ScraperError as err:
        print(f"\nERROR: {err}", file=sys.stderr)
        sys.exit(1)