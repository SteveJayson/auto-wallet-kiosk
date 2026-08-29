require('dotenv').config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(express.static(path.join(__dirname, 'public')));

const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY || "";
const PAYMONGO_AUTH = Buffer.from(PAYMONGO_SECRET_KEY + ":").toString("base64");

let transactions = [];
const MERCHANT_PIN = "1234";

// Routes for web views
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/merchant', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'merchant.html'));
});

// Real-time EventSource Stream for instant alerts
let appConnections = [];
app.get("/api/merchant/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();
    appConnections.push(res);
    req.on("close", () => { appConnections = appConnections.filter(c => c !== res); });
});

function broadcastTrigger() {
    appConnections.forEach(client => { try { client.write(`data: trigger\n\n`); } catch (e) {} });
}

// Customer submits a transaction request
app.post("/transaction/request", async (req, res) => {
    const { type, amount, mobile, provider, qr_image } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
    if (!mobile || mobile.length !== 11) return res.status(400).json({ error: "Invalid mobile number" });

    const ref = "TX-" + Date.now();
    try {
        let checkoutUrl = null;
        if (type === "withdraw") {
            const paymongoRes = await axios.post("https://api.paymongo.com/v1/links", {
                data: { attributes: { amount: Math.round(amount * 100), description: `Kiosk Cash-Out for ${mobile}`, remarks: ref } }
            }, {
                headers: { "Authorization": `Basic ${PAYMONGO_AUTH}`, "Content-Type": "application/json" }
            });
            checkoutUrl = paymongoRes.data.data.attributes.checkout_url;
        }

        transactions.push({
            id: transactions.length + 1,
            type, 
            amount: parseFloat(amount), 
            mobile, 
            provider: provider || "GCash",
            qr_image: qr_image || null,
            status: type === "withdraw" ? "pending_paymongo" : "pending_merchant",
            reference_id: ref, 
            date: new Date().toLocaleString(), 
            greeting: "", 
            receipt_image: null
        });

        broadcastTrigger();
        res.json({ message: "Request Generated", reference_id: ref, checkout_url: checkoutUrl });
    } catch (error) {
        res.status(500).json({ error: "Failed to process transaction" });
    }
});

app.get("/api/status/:refId", (req, res) => {
    const tx = transactions.find(t => t.reference_id === req.params.refId);
    if (!tx) return res.status(404).json({ error: "Not found" });
    res.json(tx);
});

app.get("/api/merchant/queue", (req, res) => {
    // Show requests that are ready for merchant review
    res.json(transactions.filter(t => t.status === "pending_merchant" || t.status === "pending_paymongo"));
});

app.post("/merchant/send", (req, res) => {
    const { pin, reference_id, greeting, receipt_image } = req.body;
    if (pin !== MERCHANT_PIN) return res.status(401).json({ error: "Unauthorized" });
    const tx = transactions.find(t => t.reference_id === reference_id);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    
    tx.status = "completed";
    tx.greeting = greeting || "Thank you for using our kiosk!";
    tx.receipt_image = receipt_image || null;
    
    broadcastTrigger();
    res.json({ message: "Sent successfully!" });
});

app.post("/paymongo-webhook", (req, res) => {
    const event = req.body;
    if (event.data?.attributes?.type === "link.payment.paid") {
        const refId = event.data.attributes.data.attributes.remarks;
        const tx = transactions.find(t => t.reference_id === refId);
        if (tx) { 
            tx.status = "completed"; 
            tx.greeting = "Payment automatically verified via PayMongo!"; 
            broadcastTrigger();
        }
    }
    res.sendStatus(200);
});

app.get("/api/merchant/history", (req, res) => {
    res.json(transactions.filter(t => t.status === "completed").reverse());
});

app.delete("/api/merchant/history/:refId", (req, res) => {
    transactions = transactions.filter(t => t.reference_id !== req.params.refId);
    res.json({ success: true });
});

app.delete("/api/merchant/history", (req, res) => {
    transactions = transactions.filter(t => t.status !== "completed");
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));