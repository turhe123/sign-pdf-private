# Private PDF Signer — specification

**Tagline:** Draw or type your signature and place it on a PDF page in your browser, with no account and no upload.

**Category:** PDF

**Free alternative to:** Smallpdf eSign PDF and DocuSign free plan (uploads contracts, free signing limited to a couple of documents per day or month, account required)

**Search phrases:** sign pdf online free, add signature to pdf, draw signature on pdf, sign pdf without account, esign pdf no upload, insert signature image pdf

**Allowed libraries:** pdf-lib, pdfjs-dist

**Published at:** https://turhe123.github.io/sign-pdf-private/

## Acceptance checks (each must have a test)

- drawing on the signature pad and pressing Use shows a signature preview
- dragging the signature onto page 1 and saving produces a PDF with an embedded image on page 1
- the saved PDF keeps the same page count as the sample
- typed signature mode produces a signature image too
- works with touch at 390px wide

## Spec

Sign pdf online free and add signature to pdf are very popular searches. Smallpdf and DocuSign style services upload the contract, require an account, and limit free signings per day or month, while the signature itself is just a picture placed on a page. Because contracts are sensitive, doing it locally is attractive.

Our version does one job: create a signature and stamp it, plus optional date text, on a chosen position of a PDF page. It is a visual signature only, not a cryptographic one, and the page says so.

UI: a drop zone for one PDF. The main area shows the current page rendered with a page stepper. A side panel creates the signature with three tabs: Draw on a canvas pad using pointer events with smooth lines and a clear button, Type with the name in a few built in script style fallbacks using generic cursive and italic system fonts, and Upload an image. Pen color options are black and blue, default blue. A Use button adds the signature to a small tray. Clicking the tray item places it on the page, where it can be dragged and resized with a corner handle, and deleted. A Add today date button places a text stamp. Multiple placements across pages are allowed. Save PDF downloads name_signed.pdf. Empty state explains the tool and privacy. Keyboard: arrow keys nudge a selected placement by one point, Shift for ten, Delete removes it.

Technical approach: pdfjs-dist renders the page to a canvas for the editor with the worker from the vendor folder. The signature pad exports a transparent PNG cropped to its ink bounds using canvas pixel scanning. Placements are stored in page relative fractions, so they map to PDF points independent of zoom. On save, pdf-lib loads the original, embeds each PNG with embedPng, and draws it at the translated position, accounting for page rotation and the origin at the bottom left. Date text uses Helvetica. Store the last signature in memory only, with an optional remember on this device checkbox using localStorage, default off. Download via Blob.

Edge cases: pointer events must call preventDefault on touch to avoid scrolling during drawing, high dpi screens need pad scaling by devicePixelRatio, pages with rotation are handled, multi page documents render only the visible page to save memory, encrypted files show an unsupported message, and Safari downloads start on tap.

Demo data: a bundled fictional two page Service Contract between Harbor Legal Demo and a freelancer named Sam Rivera, with a signature line at the bottom of page two, and a sample PNG signature scribble for the upload tab.
