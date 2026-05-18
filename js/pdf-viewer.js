// Thin PDF.js wrapper that renders every page into a canvas and lays
// highlight rectangles on top using normalized [x0,y0,x1,y1] coordinates.

const PDFViewer = (function () {
  // Tell PDF.js where to load its worker from.
  if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  async function render({ url, container, highlights = [], onHighlightClick }) {
    if (typeof pdfjsLib === "undefined") {
      throw new Error("PDF.js failed to load");
    }
    container.innerHTML = "";

    const pdf = await pdfjsLib.getDocument(url).promise;
    const byPage = groupBy(highlights, h => h.page);

    const baseWidth = Math.min(container.clientWidth - 32, 900);

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const unscaled = page.getViewport({ scale: 1 });
      const scale = baseWidth / unscaled.width;
      const viewport = page.getViewport({ scale });

      const wrap = document.createElement("div");
      wrap.className = "pdf-page-wrap";
      wrap.style.width  = `${viewport.width}px`;
      wrap.style.height = `${viewport.height}px`;

      const canvas = document.createElement("canvas");
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      wrap.appendChild(canvas);

      // Highlight overlays on this page
      for (const h of (byPage.get(pageNum) || [])) {
        if (!Array.isArray(h.rect) || h.rect.length !== 4) continue;
        const [x0, y0, x1, y1] = h.rect;
        const el = document.createElement("div");
        el.className = "pdf-highlight";
        el.style.left   = `${x0 * viewport.width}px`;
        el.style.top    = `${y0 * viewport.height}px`;
        el.style.width  = `${(x1 - x0) * viewport.width}px`;
        el.style.height = `${(y1 - y0) * viewport.height}px`;
        el.title = h.quote || h.note || "";
        if (onHighlightClick) {
          el.addEventListener("click", () => onHighlightClick(h));
        }
        wrap.appendChild(el);
      }

      container.appendChild(wrap);

      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport
      }).promise;
    }
  }

  function groupBy(arr, fn) {
    const m = new Map();
    for (const x of arr) {
      const k = fn(x);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return m;
  }

  return { render };
})();
