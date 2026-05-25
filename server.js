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
const axios = require("axios");

// --- XENDIT API CONFIG ---
// We will put your real test key here later. For now, it's a placeholder.
const XENDIT_SECRET_KEY = "xnd_development_jZQrtyIarAWPSrb0VjeVnYLGPjw9P81kBtCvmbUkZZPc6Y1GgNywQWUdEykxs"; 
// Xendit requires the key to be Base64 encoded for security
const XENDIT_AUTH = Buffer.from(XENDIT_SECRET_KEY + ":").toString("base64");

// ... (Keep your /deposit routes exact the same for now) ...


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

// 4. Automated Cash-Out: Generate Real GCash QR via Xendit
app.post("/withdraw/request", async (req, res) => {
    const { amount, mobile } = req.body;
    if (amount <= 0) return res.status(400).json({ error: "Invalid amount" });

    const ref_id = "CASH-OUT-" + uuidv4();

    try {
        // Send request to Xendit to create a GCash Payment request
        const xenditResponse = await axios.post("https://api.xendit.co/ewallets/charges", {
            reference_id: ref_id,
            currency: "PHP",
            amount: parseFloat(amount),
            checkout_method: "ONE_TIME_PAYMENT",
            channel_code: "PH_GCASH",
            channel_properties: {
                success_redirect_url: "https://auto-wallet-kiosk.onrender.com",
                failure_redirect_url: "https://auto-wallet-kiosk.onrender.com"
            }
        }, {
            headers: { 
                "Authorization": `Basic ${XENDIT_AUTH}`,
                "api-version": "2022-07-31" // <--- ADD THIS LINE
            }
        });

        const xenditData = xenditResponse.data;

        // Save to our pending memory so the Webhook can find it later
        transactions.push({
            id: transactions.length + 1,
            type: "withdraw",
            amount: parseFloat(amount),
            mobile: mobile,
            status: "pending", 
            reference_id: ref_id // We track it using Xendit's reference ID
        });

        // Xendit sends back a checkout URL (which we will turn into a QR code on the frontend)
        res.json({ 
            message: "Xendit QR Generated", 
            checkout_url: xenditData.actions.desktop_web_checkout_url,
            reference_id: ref_id
        });

    } catch (error) {
        console.error("Xendit API Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to connect to GCash API" });
    }
});

// 5. THE AUTOMATOR: Listen for Xendit's "Payment Success" signal
app.post("/xendit-webhook", (req, res) => {
    const webhookData = req.body;

    // Check if the payment actually succeeded
    if (webhookData.event === "ewallet.capture" && webhookData.data.status === "SUCCEEDED") {
        
        const ref_id = webhookData.data.reference_id;
        const tx = transactions.find(t => t.reference_id === ref_id && t.status === "pending");

        if (tx) {
            // Mark it complete in our system!
            tx.status = "completed";
            console.log(`[SUCCESS] GCash payment received for ${tx.mobile}. Ready to print receipt!`);
            
            // NOTE: In the next step, we will use WebSockets so this instantly triggers 
            // the receipt printer on the cashier's screen without them clicking anything!
        }
    }
    
    // Always reply 200 OK so Xendit knows we received the message
    res.sendStatus(200); 
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});