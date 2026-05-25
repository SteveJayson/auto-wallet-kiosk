const express = require("express");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
app.use(bodyParser.json());

app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE (Mock) ---
let users = [{ id: 1, email: "test@test.com" }];
let wallets = [{ user_id: 1, balance: 0 }];
let transactions = [];

// --- SECURITY CONFIG ---
// Hardcoded PIN for the cashier prototype. 
const MERCHANT_PIN = "1234"; 

// Helper function to generate a 6-digit OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// --- API ENDPOINTS ---

app.get("/balance/:user_id", (req, res) => {
    const wallet = wallets.find(w => w.user_id == req.params.user_id);
    res.json({ balance: wallet ? wallet.balance : 0 });
});

// 1. User Requests Deposit (Generates OTP)
app.post("/deposit/request", (req, res) => {
    const { user_id, amount, mobile, provider } = req.body;
    if (amount <= 0) return res.status(400).json({ error: "Invalid amount" });

    const otp = generateOTP();
    const ref = uuidv4();

    transactions.push({
        id: transactions.length + 1,
        user_id,
        type: "deposit",
        amount: parseFloat(amount),
        mobile: mobile, // <--- NEW: Saves the phone number
        provider: provider,
        status: "pending", 
        reference_id: ref,
        otp: otp
    });

    res.json({ message: "OTP Generated", otp: otp });
});
// 2. Merchant Login Check
app.post("/merchant/login", (req, res) => {
    const { pin } = req.body;
    if (pin === MERCHANT_PIN) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: "Invalid PIN" });
    }
});

// 3. Merchant Confirms Deposit via OTP
app.post("/merchant/confirm-deposit", (req, res) => {
    const { pin, otp } = req.body;
    
    if (pin !== MERCHANT_PIN) return res.status(401).json({ error: "Unauthorized" });

    // Find the pending transaction matching this OTP
    const tx = transactions.find(t => t.otp === otp && t.status === "pending" && t.type === "deposit");

    if (!tx) {
        return res.status(404).json({ error: "Invalid or expired OTP" });
    }

    // Approve and update balance
    tx.status = "completed";
    tx.otp = null; 
    
    const wallet = wallets.find(w => w.user_id === tx.user_id);
    wallet.balance += tx.amount;

    // Send receipt data back to the cashier's screen
    res.json({ 
        message: `Successfully credited ₱${tx.amount} to user.`,
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

// 4. User Requests Cash-Out (Generates QR Code)
app.post("/withdraw/request", (req, res) => {
    const { user_id, amount, mobile, provider } = req.body;
    const withdrawAmount = parseFloat(amount);
    const wallet = wallets.find(w => w.user_id === user_id);

    if (!wallet || wallet.balance < withdrawAmount || withdrawAmount <= 0) {
        return res.status(400).json({ error: "Insufficient balance" });
    }

    const code = "W-" + Math.floor(100000 + Math.random() * 900000).toString();
    const ref = uuidv4();

    transactions.push({
        id: transactions.length + 1,
        user_id,
        type: "withdraw",
        amount: withdrawAmount,
        mobile: mobile, // <--- NEW: Saves the phone number
        provider: provider,
        status: "pending", 
        reference_id: ref,
        code: code
    });

    res.json({ message: "QR Generated", code: code });
});

// 5. Merchant Confirms Cash-Out (Creates Digital Receipt)
app.post("/merchant/confirm-withdraw", (req, res) => {
    const { pin, code } = req.body;
    if (pin !== MERCHANT_PIN) return res.status(401).json({ error: "Unauthorized" });

    const tx = transactions.find(t => t.code === code && t.status === "pending" && t.type === "withdraw");
    if (!tx) return res.status(404).json({ error: "Invalid or expired code" });

    const wallet = wallets.find(w => w.user_id === tx.user_id);
    
    // Final security check: Did they spend the money while waiting in line?
    if (wallet.balance < tx.amount) {
        tx.status = "failed";
        return res.status(400).json({ error: "User balance dropped. Cannot approve." });
    }

    // Deduct balance and complete
    wallet.balance -= tx.amount;
    tx.status = "completed";
    tx.code = null; 

    // Inside app.post("/merchant/confirm-withdraw") ...
    res.json({
        message: "Withdrawal Approved",
        receipt: {
            tx_id: tx.reference_id,
            amount: tx.amount,
            mobile: tx.mobile, // <--- Add this line
            provider: tx.provider, // <--- Add this line
            date: new Date().toLocaleString(),
            type: "CASH-OUT"
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});