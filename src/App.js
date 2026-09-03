import React, { useState, useEffect, useRef } from "react";
import "./App.css";

// Live backend URL — update this if you ever redeploy the backend elsewhere
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:5000";

// Shown briefly on first load, then replaced by real values from GET /pricing.
// Keeping a fallback here means the page still works (with slightly stale
// numbers) even if that request fails — it is not the source of truth.
const DEFAULT_RATES = { ratePerPageBW: 3, ratePerPageColor: 10, maxFileSizeMB: 10 };

// If a request takes longer than this, we assume the backend is waking up
// from Render's free-tier sleep and let the customer know instead of
// leaving them staring at a blank screen.
const SLOW_REQUEST_THRESHOLD_MS = 4000;

let nextFileId = 1;

/**
 * Works out how many pages a file's print settings cover, for the
 * on-screen estimate. Mirrors the backend's utils/pricing.js formula —
 * the backend recalculates authoritatively when the order is created, so
 * a mismatch here would only ever affect this preview, never the charge.
 */
function resolvePageCount(entry) {
  const fallback = entry.pageCount && entry.pageCount > 0 ? entry.pageCount : 1;
  const pagesString = (entry.pages || "").trim();

  if (!pagesString) return fallback;

  if (pagesString.includes("-")) {
    const [start, end] = pagesString.split("-").map(Number);
    if (!isNaN(start) && !isNaN(end) && end >= start) return end - start + 1;
    return fallback;
  }
  if (pagesString.includes(",")) {
    const count = pagesString.split(",").filter((p) => p.trim() !== "").length;
    return count > 0 ? count : fallback;
  }
  if (!isNaN(Number(pagesString))) return 1;

  return fallback;
}

function App() {
  // shopId comes from the QR code URL, e.g. printkaro.in/?shop=sharma-xerox-01
  const [shopId, setShopId] = useState(null);
  const [shopName, setShopName] = useState(null);
  const [shopLoadError, setShopLoadError] = useState(false);
  const [rates, setRates] = useState(DEFAULT_RATES);
  const [files, setFiles] = useState([]); // [{ id, file, pages, copies, color, uploading, uploadError, fileUrl, fileName, pageCount }]
  const [submitting, setSubmitting] = useState(false);
  const [order, setOrder] = useState(null); // the created order, once submitted
  const [error, setError] = useState(null);
  const [serverWaking, setServerWaking] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shop = params.get("shop");
    setShopId(shop);
  }, []);

  // Pull this shop's effective per-page rates + file size limit from the
  // backend once we know shopId — a shop may have set its own custom rates
  // (Settings -> Print Rates), so this must never be hardcoded here.
  useEffect(() => {
    if (!shopId) return;
    fetchWithWakeNotice(`${BACKEND_URL}/pricing?shopId=${encodeURIComponent(shopId)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) =>
        setRates({
          ratePerPageBW: data.ratePerPageBW,
          ratePerPageColor: data.ratePerPageColor,
          maxFileSizeMB: data.maxFileSizeMB,
        })
      )
      .catch(() => {
        // Keep DEFAULT_RATES — the on-screen estimate may be slightly
        // stale, but the order will still be priced correctly server-side.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  // Look up the shop's display name once we know the shopId
  useEffect(() => {
    if (!shopId) return;
    fetchWithWakeNotice(`${BACKEND_URL}/shops/${shopId}`)
      .then((res) => {
        if (!res.ok) throw new Error("Shop not found");
        return res.json();
      })
      .then((data) => setShopName(data.shopName))
      .catch(() => setShopLoadError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  // Poll order status once an order has been submitted
  useEffect(() => {
    if (!order || ["completed", "failed", "rejected", "expired"].includes(order.status)) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/orders/${order._id}`);
        const data = await res.json();
        setOrder(data);
      } catch (e) {
        // silent fail — will retry on next interval
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [order]);

  /**
   * fetch() wrapper that flags `serverWaking` if a request is taking a
   * while — the most likely cause on Render's free tier is the backend
   * spinning back up after being idle, not an actual failure.
   */
  async function fetchWithWakeNotice(url, options) {
    const timer = setTimeout(() => setServerWaking(true), SLOW_REQUEST_THRESHOLD_MS);
    try {
      return await fetch(url, options);
    } finally {
      clearTimeout(timer);
      setServerWaking(false);
    }
  }

  function handleFileSelect(e) {
    const selected = Array.from(e.target.files);
    e.target.value = null; // allow re-selecting the same file if removed and re-added

    const maxBytes = rates.maxFileSizeMB * 1024 * 1024;

    selected.forEach((file) => {
      if (file.size > maxBytes) {
        setError(
          `"${file.name}" is ${(file.size / (1024 * 1024)).toFixed(1)}MB, which is over the ${rates.maxFileSizeMB}MB limit per file. Please choose a smaller file.`
        );
        return;
      }

      const id = nextFileId++;
      const entry = {
        id,
        file,
        pages: "",
        copies: 1,
        color: false,
        uploading: true,
        uploadError: null,
        fileUrl: null,
        fileName: file.name,
        pageCount: null,
      };
      setFiles((prev) => [...prev, entry]);
      uploadFile(id, file);
    });
  }

  async function uploadFile(id, file) {
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${BACKEND_URL}/upload`, { method: "POST", body: formData });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error((data && data.error) || `Failed to upload ${file.name}.`);
      }

      setFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? { ...f, uploading: false, fileUrl: data.fileUrl, fileName: data.fileName, pageCount: data.pageCount }
            : f
        )
      );
    } catch (e) {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === id ? { ...f, uploading: false, uploadError: e.message || "Upload failed." } : f
        )
      );
    }
  }

  function retryUpload(id) {
    const entry = files.find((f) => f.id === id);
    if (!entry) return;
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, uploading: true, uploadError: null } : f)));
    uploadFile(id, entry.file);
  }

  function updateFileSetting(id, key, value) {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, [key]: value } : f)));
  }

  function removeFile(id) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  function calculateTotal() {
    return files.reduce((total, f) => {
      if (!f.fileUrl) return total; // still uploading or failed — not part of the order yet
      const pageCount = resolvePageCount(f);
      const rate = f.color ? rates.ratePerPageColor : rates.ratePerPageBW;
      return total + pageCount * rate * (Number(f.copies) || 1);
    }, 0);
  }

  const hasFilesStillUploading = files.some((f) => f.uploading);
  const hasFailedUploads = files.some((f) => f.uploadError);
  const readyFiles = files.filter((f) => f.fileUrl);

  async function handleSubmit() {
    if (readyFiles.length === 0) {
      setError("Please add at least one file.");
      return;
    }
    if (hasFilesStillUploading) {
      setError("Please wait for all files to finish uploading.");
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      const uploadedFiles = readyFiles.map((f) => ({
        fileUrl: f.fileUrl,
        fileName: f.fileName,
        pages: f.pages || null,
        copies: Number(f.copies) || 1,
        color: f.color,
        pageCount: f.pageCount,
      }));

      const orderRes = await fetchWithWakeNotice(`${BACKEND_URL}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId, files: uploadedFiles }),
      });

      const orderData = await orderRes.json().catch(() => null);
      if (!orderRes.ok) {
        throw new Error((orderData && orderData.error) || "Failed to create order.");
      }
      setOrder(orderData);
    } catch (e) {
      setError(e.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function startNewOrder() {
    setOrder(null);
    setFiles([]);
    setError(null);
  }

  // ---- Status screen (after order submitted) ----
  if (order) {
    return (
      <div className="page">
        <div className="card status-card">
          <div className="brand">PrintKaro</div>
          <h1>Order #{order._id.slice(-6).toUpperCase()}</h1>
          <StatusDisplay status={order.status} message={order.statusMessage} />
          <div className="order-summary">
            <p><strong>Files:</strong> {order.files.length}</p>
            <p><strong>Estimated price:</strong> ₹{order.estimatedPrice}</p>
          </div>
          {["completed", "failed", "rejected", "expired"].includes(order.status) && (
            <button className="primary-btn" onClick={startNewOrder}>
              Start New Order
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---- No shop ID in URL at all — invalid QR / direct visit ----
  if (!shopId) {
    return (
      <div className="page">
        <div className="card status-card">
          <div className="brand">PrintKaro</div>
          <p className="empty-state">
            No shop selected. Please scan the QR code at your print shop's counter to begin.
          </p>
        </div>
      </div>
    );
  }

  // ---- Upload / configure screen ----
  return (
    <div className="page">
      <div className="card">
        <div className="brand">PrintKaro</div>
        <h1>Print Your Files</h1>
        <p className="subtitle">
          {shopLoadError ? "Shop not found" : shopName ? `at ${shopName}` : "Loading shop..."}
        </p>

        {serverWaking && (
          <p className="wake-banner">
            Waking up the server — this can take up to a minute on the first request after a period of inactivity. Please hang on.
          </p>
        )}

        <button
          className="upload-btn"
          onClick={() => fileInputRef.current.click()}
        >
          + Add Files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          multiple
          hidden
          onChange={handleFileSelect}
        />

        {files.length === 0 && (
          <p className="empty-state">No files added yet. Tap "+ Add Files" to begin.</p>
        )}

        {files.map((f) => (
          <div className="file-row" key={f.id}>
            <div className="file-header">
              <span className="file-name">{f.fileName}</span>
              <button className="remove-btn" onClick={() => removeFile(f.id)}>✕</button>
            </div>

            {f.uploading && <p className="file-status">Uploading...</p>}
            {f.uploadError && (
              <p className="file-status file-status-error">
                {f.uploadError}{" "}
                <button className="retry-link" onClick={() => retryUpload(f.id)}>Retry</button>
              </p>
            )}
            {!f.uploading && !f.uploadError && f.pageCount != null && (
              <p className="file-status">{f.pageCount} page{f.pageCount === 1 ? "" : "s"} detected</p>
            )}
            {!f.uploading && !f.uploadError && f.pageCount == null && f.fileUrl && (
              <p className="file-status">Page count unavailable — enter it manually below if needed.</p>
            )}

            <div className="file-settings">
              <label>
                Pages
                <input
                  type="text"
                  placeholder={f.pageCount ? `All (${f.pageCount})` : "All"}
                  value={f.pages}
                  onChange={(e) => updateFileSetting(f.id, "pages", e.target.value)}
                />
              </label>
              <label>
                Copies
                <input
                  type="number"
                  min="1"
                  value={f.copies}
                  onChange={(e) => updateFileSetting(f.id, "copies", e.target.value)}
                />
              </label>
              <label className="color-toggle">
                Color
                <input
                  type="checkbox"
                  checked={f.color}
                  onChange={(e) => updateFileSetting(f.id, "color", e.target.checked)}
                />
              </label>
            </div>
          </div>
        ))}

        {files.length > 0 && (
          <div className="total-row">
            <span>Estimated Total</span>
            <span className="total-amount">₹{calculateTotal()}</span>
          </div>
        )}

        {error && <p className="error-text">{error}</p>}

        <button
          className="primary-btn"
          disabled={readyFiles.length === 0 || hasFilesStillUploading || hasFailedUploads || submitting}
          onClick={handleSubmit}
        >
          {submitting ? "Submitting..." : hasFilesStillUploading ? "Uploading..." : "Submit Order"}
        </button>
      </div>
    </div>
  );
}

function StatusDisplay({ status, message }) {
  const statusConfig = {
    awaiting_approval: { label: "Waiting for shop approval", color: "#f59e0b" },
    pending: { label: "Approved — queued to print", color: "#3b82f6" },
    printing: { label: "Printing now", color: "#3b82f6" },
    completed: { label: "Ready for pickup!", color: "#22c55e" },
    failed: { label: "Print failed", color: "#ef4444" },
    rejected: { label: "Order rejected", color: "#ef4444" },
    expired: { label: "Order expired — please submit a new one", color: "#ef4444" },
  };

  const config = statusConfig[status] || { label: status, color: "#6b7280" };

  return (
    <div className="status-display">
      <div className="status-dot" style={{ backgroundColor: config.color }} />
      <span style={{ color: config.color }}>{config.label}</span>
      {message && <p className="status-message">{message}</p>}
    </div>
  );
}

export default App;
