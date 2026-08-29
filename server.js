require('dotenv').config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const app = express();

// Handle large payloads (for screenshot uploads)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files from root and public folder if it exists
app.use(express.static(__dirname));
if (fs.existsSync(path.join(__dirname, 'public'))) {
    app.use(express.static(path.join(__dirname, 'public')));
}

// --- PAYMONGO CONFIG ---
const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY || "";
const PAYMONGO_AUTH = Buffer.from(PAYMONGO_SECRET_KEY + ":").toString("base64");

let transactions = [];
const MERCHANT_PIN = "1234";

// ==========================================
// ROUTE: SERVE HTML PAGES SAFELY
// ==========================================
function sendHtmlFile(res, fileName) {
    const rootPath = path.join(__dirname, fileName);
    const publicPath = path.join(__dirname, 'public', fileName);

    if (fs.existsSync(rootPath)) {
        return res.sendFile(rootPath);
    } else if (fs.existsSync(publicPath)) {
        return res.sendFile(publicPath);
    } else {
        return res.status(404).send(`Error: ${fileName} not found on server.`);
    }
}

app.get('/', (req, res) => {
    sendHtmlFile(res, 'index.html');
});

app.get('/merchant', (req, res) => {
    sendHtmlFile(res, 'merchant.html');
});

// ==========================================
// ZERO-DELAY APP CONNECTION (SSE)
// ==========================================
let appConnections = [];
app.get("/api/merchant/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();

    appConnections.push(res);

    req.on("close", () => {
        appConnections = appConnections.filter(client => client !== res);
    });
});

// ==========================================
// TRANSACTION ENDPOINTS
// ==========================================

// 1. Customer Requests Ticket
app.post("/transaction/request", async (req, res) => {
    const { type, amount, mobile, provider } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
    if (!mobile || mobile.length !== 11) return res.status(400).json({ error: "Invalid mobile number" });

    const ref = "TX-" + Date.now();

    try {
        let checkoutUrl = null;

        if (type === "withdraw") {
            const paymongoRes = await axios.post("https://api.paymongo.com/v1/links", {
                data: {
                    attributes: {
                        amount: Math.round(amount * 100),
                        description: `Kiosk Cash-Out for ${mobile}`,
                        remarks: ref
                    }
                }
            }, {
                headers: {
                    "Authorization": `Basic ${PAYMONGO_AUTH}`,
                    "Content-Type": "application/json"
                }
            });
            checkoutUrl = paymongoRes.data.data.attributes.checkout_url;
        }

        transactions.push({
            id: transactions.length + 1,
            type: type,
            amount: parseFloat(amount),
            mobile: mobile,
            provider: provider || "GCash",
            status: type === "withdraw" ? "pending_paymongo" : "pending_merchant",
            reference_id: ref,
            date: new Date().toLocaleString(),
            greeting: "",
            receipt_image: null
        });

        // Instant notification trigger
        appConnections.forEach(client => {
            try {
                client.write(`data: trigger\n\n`);
            } catch (e) {}
        });

        res.json({ message: "Request Generated", reference_id: ref, checkout_url: checkoutUrl });

    } catch (error) {
        console.error("Transaction Request Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to process transaction" });
    }
});

// 2. Status Polling
app.get("/api/status/:refId", (req, res) => {
    const tx = transactions.find(t => t.reference_id === req.params.refId);
    if (!tx) return res.status(404).json({ error: "Not found" });
    res.json(tx);
});

// 3. Live Queue
app.get("/api/merchant/queue", (req, res) => {
    const queue = transactions.filter(t => t.status === "pending_merchant");
    res.json(queue);
});

// 4. Complete Cash-In
app.post("/merchant/send", (req, res) => {
    const { pin, reference_id, greeting, receipt_image } = req.body;

    if (pin !== MERCHANT_PIN) return res.status(401).json({ error: "Unauthorized" });

    const tx = transactions.find(t => t.reference_id === reference_id);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });

    tx.status = "completed";
    tx.greeting = greeting || "Thank you for using our kiosk!";
    tx.receipt_image = receipt_image || null;

    res.json({ message: "Sent to customer successfully!" });
});

// 5. PayMongo Webhook
app.post("/paymongo-webhook", (req, res) => {
    const event = req.body;
    if (event.data && event.data.attributes && event.data.attributes.type === "link.payment.paid") {
        const refId = event.data.attributes.data.attributes.remarks;
        const tx = transactions.find(t => t.reference_id === refId && t.status === "pending_paymongo");
        if (tx) {
            tx.status = "completed";
            tx.greeting = "Payment automatically verified via PayMongo!";
        }
    }
    res.sendStatus(200);
});

// 6. History
app.get("/api/merchant/history", (req, res) => {
    const history = transactions.filter(t => t.status === "completed").reverse();
    res.json(history);
});

// 7. Delete Single Record
app.delete("/api/merchant/history/:refId", (req, res) => {
    const refId = req.params.refId;
    transactions = transactions.filter(t => t.reference_id !== refId);
    res.json({ success: true });
});

// 8. Clear History
app.delete("/api/merchant/history", (req, res) => {
    transactions = transactions.filter(t => t.status !== "completed");
    res.json({ success: true });
});

// Global Error Handler (Prevents unexpected 500 crashes)
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack);
    res.status(500).send("Server Error: " + err.message);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});