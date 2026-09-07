# Manual records

Scanned invoices have no text layer, and this environment has no OCR engine, so
those visits are transcribed here by hand (or by a vision model) instead of
being silently dropped.

One JSON file per document. The pipeline loads every `*.json` in this folder and
treats the records exactly like parsed ones — `document` should name the PDF in
`data/pdfs/` so the two can be matched up and de-duplicated.

Schema: see `Visit` in `vehicle_maintenance/models.py`. Dates are `YYYY-MM-DD`.
Money is in shekels; `total` is the final amount including VAT.
