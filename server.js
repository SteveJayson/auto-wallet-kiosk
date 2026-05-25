const express = require("express");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE (Temporary Memory for Today's Tickets) ---
let transactions = [];
const MERCHANT_PIN = "1234"; 

// Generates a 6-digit code for the cashier to type in
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// --- API ENDPOINTS ---

// 1. Customer Requests Ticket
app.post("/transaction/request", (req, res) => {
    const { type, amount, mobile, provider } = req.body;
    
    // Basic validation
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
    if (!mobile || mobile.length !== 11) return res.status(400).json({ error: "Invalid mobile number" });

    const ticketCode = generateOTP();
    const ref = uuidv4();

    transactions.push({
        id: transactions.length + 1,
        type: type, 
        amount: parseFloat(amount),
        mobile: mobile,
        provider: provider,
        status: "pending", 
        reference_id: ref,
        code: ticketCode,
        date: new Date().toLocaleString()
    });

    res.json({ message: "Ticket Generated", code: ticketCode, reference_id: ref });
});

// 2. Customer Screen Polling ("Is my receipt ready?")
app.get("/api/status/:refId", (req, res) => {
    const tx = transactions.find(t => t.reference_id === req.params.refId);
    if (!tx) return res.status(404).json({ error: "Not found" });
    
    res.json(tx); 
});

// 3. Cashier Approves Ticket
app.post("/merchant/confirm", (req, res) => {
    const { pin, code } = req.body;
    
    if (pin !== MERCHANT_PIN) return res.status(401).json({ error: "Unauthorized" });

    const tx = transactions.find(t => t.code === code && t.status === "pending");
    if (!tx) return res.status(404).json({ error: "Invalid or expired Ticket Code" });

    // Mark as completed! 
    tx.status = "completed";
    
    res.json({ message: "Approved successfully", receipt: tx });
});

// --- SERVER START ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});