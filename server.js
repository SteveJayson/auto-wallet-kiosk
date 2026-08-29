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

// --- IN-MEMORY DATABASE ---
let transactions = [];
const MERCHANT_PIN = "1234"; 

// 1. Customer Requests Ticket
app.post("/transaction/request", async (req, res) => {
    const { type, amount, mobile, provider } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
    if (!mobile || mobile.length !== 11) return res.status(400).json({ error: "Invalid mobile number" });

    const ref = uuidv4();

    try {
        let checkoutUrl = null;

        // If it's a Cash-Out, ask PayMongo to generate a payment link
        if (type === "withdraw") {
            const paymongoRes = await axios.post("https://api.paymongo.com/v1/links", {
                data: {
                    attributes: {
                        amount: amount * 100, // Convert PHP to Centavos
                        description: `Kiosk Cash-Out for ${mobile}`,
                        remarks: ref // Hidden tag to track the transaction
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

        // Save the transaction to the database
        transactions.push({
            id: transactions.length + 1,
            type: type, 
            amount: parseFloat(amount),
            mobile: mobile,
            provider: provider,
            // Cash-outs wait for PayMongo webhook. Cash-ins wait for Merchant Dashboard.
            status: type === "withdraw" ? "pending_paymongo" : "pending_merchant", 
            reference_id: ref,
            date: new Date().toLocaleString(),
            greeting: "",
            receipt_image: null 
        });

        // Send back the PayMongo link (if cash-out) and the tracking ID
        res.json({ message: "Request Generated", reference_id: ref, checkout_url: checkoutUrl });

    } catch (error) {
        console.error("PayMongo Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to connect to payment gateway" });
    }
});

// 2. Customer Screen Polling (Checks if Merchant or PayMongo finished the job)
app.get("/api/status/:refId", (req, res) => {
    const tx = transactions.find(t => t.reference_id === req.params.refId);
    if (!tx) return res.status(404).json({ error: "Not found" });
    res.json(tx); 
});

// 3. NEW: Merchant Dashboard fetches the live Cash-In Queue
app.get("/api/merchant/queue", (req, res) => {
    // Only send transactions that are waiting for the merchant to manually process
    const queue = transactions.filter(t => t.status === "pending_merchant");
    res.json(queue);
});

// 4. Cashier Finishes Cash-In (Sends Final Receipt + Greeting + Image)
app.post("/merchant/send", (req, res) => {
    const { pin, reference_id, greeting, receipt_image } = req.body; 
    
    if (pin !== MERCHANT_PIN) return res.status(401).json({ error: "Unauthorized" });

    const tx = transactions.find(t => t.reference_id === reference_id);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });

    tx.status = "completed"; // This instantly updates the polling customer screen!
    tx.greeting = greeting || "Thank you for using our kiosk!"; 
    tx.receipt_image = receipt_image || null; 
    
    res.json({ message: "Sent to customer successfully!" });
});

// 5. PayMongo Webhook Listener (For Cash-Outs)
app.post("/paymongo-webhook", (req, res) => {
    const event = req.body;

    if (event.data && event.data.attributes && event.data.attributes.type === "link.payment.paid") {
        
        const refId = event.data.attributes.data.attributes.remarks;
        const tx = transactions.find(t => t.reference_id === refId && t.status === "pending_paymongo");

        if (tx) {
            tx.status = "completed"; // Instantly updates the customer screen
            tx.greeting = "Payment automatically verified via PayMongo!";
            console.log(`[SUCCESS] PayMongo payment received for REF: ${refId}`);
        }
    }
    
    res.sendStatus(200); 
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// ==========================================
// NEW: HISTORY MANAGEMENT ENDPOINTS
// ==========================================

// 6. Fetch Completed History (Newest first)
app.get("/api/merchant/history", (req, res) => {
    const history = transactions.filter(t => t.status === "completed").reverse();
    res.json(history);
});

// 7. Delete a single transaction from history
app.delete("/api/merchant/history/:refId", (req, res) => {
    const refId = req.params.refId;
    // Keep all transactions EXCEPT the one that matches this ID
    transactions = transactions.filter(t => t.reference_id !== refId);
    res.json({ success: true, message: "Transaction deleted" });
});

// 8. Clear ALL history
app.delete("/api/merchant/history", (req, res) => {
    // Keep only the pending transactions, wiping out the completed ones
    transactions = transactions.filter(t => t.status !== "completed");
    res.json({ success: true, message: "All history cleared" });
});