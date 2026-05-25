const express = require("express");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE (Temporary Memory) ---
// We only need to track the pending tickets for the day!
let transactions = [];

// --- SECURITY CONFIG ---
const MERCHANT_PIN = "1234"; 

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// --- API ENDPOINTS ---

// 1. User Requests Cash-In (Deposit)
app.post("/deposit/request", (req, res) => {
    const { amount, mobile, provider } = req.body;
    if (amount <= 0) return res.status(400).json({ error: "Invalid amount" });

    const otp = generateOTP();
    const ref = uuidv4();

    transactions.push({
        id: transactions.length + 1,
        type: "deposit",
        amount: parseFloat(amount),
        mobile: mobile,
        provider: provider,
        status: "pending", 
        reference_id: ref,
        otp: otp
    });

    res.json({ message: "OTP Generated", otp: otp });
});

// 2. Merchant Login
app.post("/merchant/login", (req, res) => {
    const { pin } = req.body;
    if (pin === MERCHANT_PIN) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: "Invalid PIN" });
    }
});

// 3. Merchant Confirms Cash-In (After sending money via real GCash App)
app.post("/merchant/confirm-deposit", (req, res) => {
    const { pin, otp } = req.body;
    
    if (pin !== MERCHANT_PIN) return res.status(401).json({ error: "Unauthorized" });

    const tx = transactions.find(t => t.otp === otp && t.status === "pending" && t.type === "deposit");
    if (!tx) return res.status(404).json({ error: "Invalid or expired OTP" });

    // Mark ticket as completed (No fake balance math needed!)
    tx.status = "completed";
    tx.otp = null; 
    
    res.json({ 
        message: "Receipt Generated",
        receipt: {
            tx_id: tx.reference_id,
            amount: tx.amount,
            mobile: tx.mobile, 
            provider: tx.provider,
            date: new Date().toLocaleString(),
            type: "CASH-IN" 
        }
    });
});

// 4. User Requests Cash-Out (Withdraw)
app.post("/withdraw/request", (req, res) => {
    const { amount, mobile, provider } = req.body;
    if (amount <= 0) return res.status(400).json({ error: "Invalid amount" });

    // Generates the Code/QR data
    const code = "W-" + Math.floor(100000 + Math.random() * 900000).toString();
    const ref = uuidv4();

    transactions.push({
        id: transactions.length + 1,
        type: "withdraw",
        amount: parseFloat(amount),
        mobile: mobile,
        provider: provider,
        status: "pending", 
        reference_id: ref,
        code: code
    });

    res.json({ message: "QR Generated", code: code });
});

// 5. Merchant Confirms Cash-Out (After receiving money on real GCash App)
app.post("/merchant/confirm-withdraw", (req, res) => {
    const { pin, code } = req.body;
    if (pin !== MERCHANT_PIN) return res.status(401).json({ error: "Unauthorized" });

    const tx = transactions.find(t => t.code === code && t.status === "pending" && t.type === "withdraw");
    if (!tx) return res.status(404).json({ error: "Invalid or expired code" });

    // Mark ticket as completed (No fake balance checks needed!)
    tx.status = "completed";
    tx.code = null; 

    res.json({
        message: "Receipt Generated",
        receipt: {
            tx_id: tx.reference_id,
            amount: tx.amount,
            mobile: tx.mobile,
            provider: tx.provider,
            date: new Date().toLocaleString(),
            type: "CASH-OUT"
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});