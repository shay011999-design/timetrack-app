"""Turn a PDF into something a parser can work with.

Two shapes come out of the source documents:
  * born-digital PDFs, where pypdf gives us the text directly;
  * scans, where the page is a single JPEG and there is no text layer.

Scans are reported as such rather than guessed at, so the caller can fall back
to the manual records in ``data/manual`` instead of silently losing a visit.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pypdf

# Below this many characters a page is treated as having no usable text layer.
TEXT_LAYER_MIN_CHARS = 40


@dataclass
class ExtractedDoc:
    path: Path
    pages: list[str]
    is_scan: bool

    @property
    def text(self) -> str:
        return "\n".join(self.pages)

    @property
    def name(self) -> str:
        return self.path.name


def extract(path: str | Path) -> ExtractedDoc:
    path = Path(path)
    reader = pypdf.PdfReader(str(path))
    pages = [(p.extract_text() or "").strip() for p in reader.pages]
    is_scan = sum(len(p) for p in pages) < TEXT_LAYER_MIN_CHARS
    return ExtractedDoc(path=path, pages=pages, is_scan=is_scan)


def page_images(path: str | Path) -> list[bytes]:
    """Embedded images, so a scan can be handed to an OCR/vision step."""
    reader = pypdf.PdfReader(str(path))
    return [img.data for page in reader.pages for img in page.images]
