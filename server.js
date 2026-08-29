require('dotenv').config(); 
const express = require("express");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const axios = require("axios"); 

const app = express();

app.use(bodyParser.json({ limit: '50mb' })); 
app.use(express.static(path.join(__dirname, 'public')));

// --- PAYMONGO CONFIG ---
const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY; 
const PAYMONGO_AUTH = Buffer.from(PAYMONGO_SECRET_KEY + ":").toString("base64");

let transactions = [];
const MERCHANT_PIN = "1234"; 

// ==========================================
// NEW: ZERO-DELAY APP CONNECTION (SSE)
// ==========================================
let appConnections = [];
app.get("/api/merchant/stream", (req, res) => {
    // This keeps a persistent connection open to your phone
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders(); 
    
    appConnections.push(res);
    
    req.on("close", () => {
        appConnections = appConnections.filter(client => client !== res);
    });
});

// 1. Customer Requests Ticket
app.post("/transaction/request", async (req, res) => {
    const { type, amount, mobile, provider } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
    if (!mobile || mobile.length !== 11) return res.status(400).json({ error: "Invalid mobile number" });

    const ref = uuidv4();

    try {
        let checkoutUrl = null;

        if (type === "withdraw") {
            const paymongoRes = await axios.post("https://api.paymongo.com/v1/links", {
                data: {
                    attributes: {
                        amount: amount * 100, 
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
            provider: provider,
            status: type === "withdraw" ? "pending_paymongo" : "pending_merchant", 
            reference_id: ref,
            date: new Date().toLocaleString(),
            greeting: "",
            receipt_image: null 
        });

        // 🚨 INSTANT APP TRIGGER 🚨
        // The exact millisecond the transaction is saved, it forces your phone app to ring!
        appConnections.forEach(client => client.write(`data: trigger\n\n`));

        res.json({ message: "Request Generated", reference_id: ref, checkout_url: checkoutUrl });

    } catch (error) {
        console.error("PayMongo Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to connect to payment gateway" });
    }
});

// 2. Customer Screen Polling 
app.get("/api/status/:refId", (req, res) => {
    const tx = transactions.find(t => t.reference_id === req.params.refId);
    if (!tx) return res.status(404).json({ error: "Not found" });
    res.json(tx); 
});

// 3. Merchant Dashboard fetches the live Queue
app.get("/api/merchant/queue", (req, res) => {
    const queue = transactions.filter(t => t.status === "pending_merchant");
    res.json(queue);
});

// 4. Cashier Finishes Cash-In 
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

// 5. PayMongo Webhook Listener
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

// 6. Fetch Completed History 
app.get("/api/merchant/history", (req, res) => {
    const history = transactions.filter(t => t.status === "completed").reverse();
    res.json(history);
});

// 7. Delete a single transaction
app.delete("/api/merchant/history/:refId", (req, res) => {
    const refId = req.params.refId;
    transactions = transactions.filter(t => t.reference_id !== refId);
    res.json({ success: true });
});

// 8. Clear ALL history
app.delete("/api/merchant/history", (req, res) => {
    transactions = transactions.filter(t => t.status !== "completed");
    res.json({ success: true });
});

// ==========================================
// SERVE THE HTML PAGES (This fixes the 500 Error!)
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/merchant', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'merchant.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});