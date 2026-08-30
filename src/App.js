import React, { useState, useEffect, useRef } from "react";
import "./App.css";

// Live backend URL — update this if you ever redeploy the backend elsewhere
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:5000";

// Simple pricing shown to the customer as an estimate (should match backend rates)
const RATE_PER_PAGE_BW = 2;
const RATE_PER_PAGE_COLOR = 10;

function estimatePageCount(pagesString) {
  if (!pagesString) return 1;
  if (pagesString.includes("-")) {
    const [start, end] = pagesString.split("-").map(Number);
    if (isNaN(start) || isNaN(end) || end < start) return 1;
    return end - start + 1;
  }
  if (pagesString.includes(",")) {
    return pagesString.split(",").filter(Boolean).length;
  }
  return 1;
}

function App() {
  // shopId comes from the QR code URL, e.g. printkaro.in/?shop=sharma-xerox-01
  const [shopId, setShopId] = useState(null);
  const [shopName, setShopName] = useState(null);
  const [shopLoadError, setShopLoadError] = useState(false);
  const [files, setFiles] = useState([]); // [{ file, pages, copies, color }]
  const [submitting, setSubmitting] = useState(false);
  const [order, setOrder] = useState(null); // the created order, once submitted
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shop = params.get("shop");
    setShopId(shop);
  }, []);

  // Look up the shop's display name once we know the shopId
  useEffect(() => {
    if (!shopId) return;
    fetch(`${BACKEND_URL}/shops/${shopId}`)
      .then((res) => {
        if (!res.ok) throw new Error("Shop not found");
        return res.json();
      })
      .then((data) => setShopName(data.shopName))
      .catch(() => setShopLoadError(true));
  }, [shopId]);

  // Poll order status once an order has been submitted
  useEffect(() => {
    if (!order || ["completed", "failed", "rejected"].includes(order.status)) return;

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

  function handleFileSelect(e) {
    const selected = Array.from(e.target.files);
    const newEntries = selected.map((file) => ({
      file,
      pages: "",
      copies: 1,
      color: false,
    }));
    setFiles((prev) => [...prev, ...newEntries]);
    e.target.value = null; // allow re-selecting the same file if removed and re-added
  }

  function updateFileSetting(index, key, value) {
    setFiles((prev) =>
      prev.map((f, i) => (i === index ? { ...f, [key]: value } : f))
    );
  }

  function removeFile(index) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function calculateTotal() {
    return files.reduce((total, f) => {
      const pageCount = estimatePageCount(f.pages);
      const rate = f.color ? RATE_PER_PAGE_COLOR : RATE_PER_PAGE_BW;
      return total + pageCount * rate * (f.copies || 1);
    }, 0);
  }

  async function handleSubmit() {
    if (files.length === 0) {
      setError("Please add at least one file.");
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      // 1. Upload each file to the backend (which forwards to Cloudinary)
      const uploadedFiles = [];
      for (const f of files) {
        const formData = new FormData();
        formData.append("file", f.file);

        const uploadRes = await fetch(`${BACKEND_URL}/upload`, {
          method: "POST",
          body: formData,
        });

        if (!uploadRes.ok) throw new Error(`Failed to upload ${f.file.name}`);
        const uploadData = await uploadRes.json();

        uploadedFiles.push({
          fileUrl: uploadData.fileUrl,
          fileName: uploadData.fileName,
          pages: f.pages || null,
          copies: Number(f.copies) || 1,
          color: f.color,
        });
      }

      // 2. Create the order
      const orderRes = await fetch(`${BACKEND_URL}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId, files: uploadedFiles }),
      });

      if (!orderRes.ok) throw new Error("Failed to create order.");
      const orderData = await orderRes.json();
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
          {["completed", "failed", "rejected"].includes(order.status) && (
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

        {files.map((f, index) => (
          <div className="file-row" key={index}>
            <div className="file-header">
              <span className="file-name">{f.file.name}</span>
              <button className="remove-btn" onClick={() => removeFile(index)}>✕</button>
            </div>
            <div className="file-settings">
              <label>
                Pages
                <input
                  type="text"
                  placeholder="All"
                  value={f.pages}
                  onChange={(e) => updateFileSetting(index, "pages", e.target.value)}
                />
              </label>
              <label>
                Copies
                <input
                  type="number"
                  min="1"
                  value={f.copies}
                  onChange={(e) => updateFileSetting(index, "copies", e.target.value)}
                />
              </label>
              <label className="color-toggle">
                Color
                <input
                  type="checkbox"
                  checked={f.color}
                  onChange={(e) => updateFileSetting(index, "color", e.target.checked)}
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
          disabled={files.length === 0 || submitting}
          onClick={handleSubmit}
        >
          {submitting ? "Submitting..." : "Submit Order"}
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