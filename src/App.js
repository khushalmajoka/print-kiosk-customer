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

const WIZARD_STEPS = [
  { n: 1, label: "Upload" },
  { n: 2, label: "Configure" },
  { n: 3, label: "Review" },
];

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
  const [step, setStep] = useState(1); // 1: upload, 2: configure, 3: review
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

  // Step 1 (Upload) can't be left until every added file has either
  // finished uploading successfully or been removed — this keeps the
  // "which files" decision fully contained to step 1, so step 2 only
  // ever deals with files that are actually ready to be printed.
  const canLeaveUploadStep = readyFiles.length > 0 && !hasFilesStillUploading && !hasFailedUploads;

  function goToStep(n) {
    setStep(n);
  }

  function goNext() {
    setError(null);
    setStep((s) => Math.min(s + 1, 3));
  }

  function goBack() {
    setError(null);
    setStep((s) => Math.max(s - 1, 1));
  }

  async function handleSubmit() {
    if (readyFiles.length === 0 || hasFilesStillUploading || hasFailedUploads) {
      setError("Please go back and resolve any pending or failed uploads first.");
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
    setStep(1);
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
          <div className="empty-state-wrap">
            <div className="empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
                <rect x="4" y="4" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.6" />
                <rect x="13" y="4" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.6" />
                <rect x="4" y="13" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.6" />
                <path d="M14 15h5.5M16.5 13v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </div>
            <p className="empty-state">
              No shop selected. Please scan the QR code at your print shop's counter to begin.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ---- Upload / Configure / Review wizard ----
  return (
    <div className="page">
      <div className="card">
        <div className="brand">PrintKaro</div>
        <h1>Print Your Files</h1>
        <p className="subtitle">
          {shopLoadError ? "Shop not found" : shopName ? `at ${shopName}` : "Loading shop..."}
        </p>

        <WizardSteps step={step} onStepClick={goToStep} />

        {serverWaking && (
          <p className="wake-banner">
            Waking up the server — this can take up to a minute on the first request after a period of inactivity. Please hang on.
          </p>
        )}

        {/* ---- Step 1: Upload ---- */}
        {step === 1 && (
          <>
            <button className="upload-btn" onClick={() => fileInputRef.current.click()}>
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
              <div className="empty-state-wrap">
                <div className="empty-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
                    <path d="M12 3v10m0 0l-3.5-3.5M12 13l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M6 15v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <p className="empty-state">No files added yet. Tap "+ Add Files" to begin.</p>
              </div>
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
                  <p className="file-status">Page count unavailable — you can enter it manually in the next step.</p>
                )}
              </div>
            ))}

            {error && <p className="error-text">{error}</p>}

            <button className="primary-btn" disabled={!canLeaveUploadStep} onClick={goNext}>
              Next: Configure Settings →
            </button>
          </>
        )}

        {/* ---- Step 2: Configure ---- */}
        {step === 2 && (
          <>
            {readyFiles.map((f) => (
              <div className="file-row" key={f.id}>
                <div className="file-header">
                  <span className="file-name">{f.fileName}</span>
                </div>

                {f.pageCount != null ? (
                  <p className="file-status">{f.pageCount} page{f.pageCount === 1 ? "" : "s"} detected</p>
                ) : (
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

            <div className="wizard-nav">
              <button className="back-link" onClick={goBack}>← Back</button>
              <button className="primary-btn wizard-nav-primary" onClick={goNext}>
                Next: Review Order →
              </button>
            </div>
          </>
        )}

        {/* ---- Step 3: Review ---- */}
        {step === 3 && (
          <>
            <div className="review-list">
              {readyFiles.map((f) => {
                const pageCount = resolvePageCount(f);
                const rate = f.color ? rates.ratePerPageColor : rates.ratePerPageBW;
                const linePrice = pageCount * rate * (Number(f.copies) || 1);
                return (
                  <div className="review-row" key={f.id}>
                    <div className="review-row-main">
                      <span className="review-file-name">{f.fileName}</span>
                      <span className="review-file-price">₹{linePrice}</span>
                    </div>
                    <div className="review-file-meta">
                      {pageCount} page{pageCount === 1 ? "" : "s"} × {f.copies} {Number(f.copies) === 1 ? "copy" : "copies"} · {f.color ? "Color" : "B&W"}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="total-row">
              <span>Estimated Total</span>
              <span className="total-amount">₹{calculateTotal()}</span>
            </div>

            {error && <p className="error-text">{error}</p>}

            <div className="wizard-nav">
              <button className="back-link" onClick={goBack} disabled={submitting}>← Back</button>
              <button
                className="primary-btn wizard-nav-primary"
                disabled={readyFiles.length === 0 || hasFilesStillUploading || hasFailedUploads || submitting}
                onClick={handleSubmit}
              >
                {submitting ? "Submitting..." : "Submit Order"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function WizardSteps({ step, onStepClick }) {
  return (
    <div className="wizard-steps">
      {WIZARD_STEPS.map((s, i) => {
        let state = "upcoming";
        if (s.n < step) state = "done";
        else if (s.n === step) state = "active";

        // Only completed (earlier) steps can be jumped back to directly —
        // moving forward always goes through the Next button so its
        // validation actually runs.
        const clickable = state === "done";

        return (
          <div className="wizard-step" key={s.n}>
            <div className="wizard-step-track">
              {i > 0 && <div className={`wizard-connector ${s.n <= step ? "wizard-connector-filled" : ""}`} />}
              <button
                type="button"
                className={`wizard-dot wizard-dot-${state}`}
                onClick={() => clickable && onStepClick(s.n)}
                disabled={!clickable}
              >
                {state === "done" ? "\u2713" : s.n}
              </button>
            </div>
            <span className={`wizard-label ${state === "upcoming" ? "wizard-label-upcoming" : ""}`}>{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function StatusDisplay({ status, message }) {
  const STEP_ORDER = ["awaiting_approval", "pending", "printing", "completed"];
  const STEP_LABELS = { awaiting_approval: "Approval", pending: "Queued", printing: "Printing", completed: "Done" };
  const STATUS_TEXT = {
    awaiting_approval: "Waiting for shop approval",
    pending: "Approved — queued to print",
    printing: "Printing now",
    completed: "Ready for pickup!",
    failed: "Print failed",
    rejected: "Order rejected",
    expired: "Order expired — please submit a new one",
  };

  // rejected/expired always happen right at the approval stage (the shop
  // never moved it forward); failed always happens after printing was
  // attempted (the last step). Anything else maps directly onto a step.
  let activeIndex = STEP_ORDER.indexOf(status);
  let errorIndex = null;
  if (status === "rejected" || status === "expired") {
    activeIndex = 0;
    errorIndex = 0;
  } else if (status === "failed") {
    activeIndex = STEP_ORDER.length - 1;
    errorIndex = STEP_ORDER.length - 1;
  } else if (activeIndex === -1) {
    activeIndex = 0;
  }

  const label = STATUS_TEXT[status] || status;
  const textColor = errorIndex !== null ? "var(--red-600)" : status === "completed" ? "var(--green-600)" : "var(--indigo-500)";

  return (
    <div className="status-display">
      <div className="stepper">
        {STEP_ORDER.map((step, i) => {
          let state = "upcoming";
          if (errorIndex === i) state = "error";
          else if (i < activeIndex) state = "done";
          else if (i === activeIndex) state = activeIndex === STEP_ORDER.length - 1 && errorIndex === null ? "success" : "active";

          return (
            <div className="step" key={step}>
              <div className="step-track">
                {i > 0 && <div className={`step-connector ${i <= activeIndex ? "step-connector-filled" : ""}`} />}
                <div className={`step-circle step-${state}`}>
                  {(state === "done" || state === "success") && "\u2713"}
                  {state === "error" && "\u2715"}
                </div>
              </div>
              <span className={`step-label ${state === "upcoming" ? "step-label-upcoming" : ""}`}>{STEP_LABELS[step]}</span>
            </div>
          );
        })}
      </div>
      <p className="status-text" style={{ color: textColor }}>{label}</p>
      {message && <p className="status-message">{message}</p>}
    </div>
  );
}

export default App;
