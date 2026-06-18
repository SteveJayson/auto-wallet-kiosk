const express = require("express");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const axios = require("axios"); // NEW: Required for PayMongo

const app = express();

// 🚨 CRITICAL FIX FOR IMAGES: Increase the limit to 50mb!
app.use(bodyParser.json({ limit: '50mb' })); 
app.use(express.static(path.join(__dirname, 'public')));

// --- PAYMONGO CONFIG ---
// Replace this with your actual Secret Key from the PayMongo dashboard
const PAYMONGO_SECRET_KEY = "sk_test_ktesnPmh7TTdjdekqkUWhLPb"; 
const PAYMONGO_AUTH = Buffer.from(PAYMONGO_SECRET_KEY + ":").toString("base64");

// --- DATABASE ---
let transactions = [];
const MERCHANT_PIN = "1234"; 

function generateOTP() {
    // Generates a random 3-digit number from 100 to 999
    return Math.floor(100 + Math.random() * 900).toString();
}

// 1. Customer Requests Ticket (UPDATED FOR PAYMONGO)
app.post("/transaction/request", async (req, res) => {
    const { type, amount, mobile, provider } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
    if (!mobile || mobile.length !== 11) return res.status(400).json({ error: "Invalid mobile number" });

    const ticketCode = generateOTP();
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

        transactions.push({
            id: transactions.length + 1,
            type: type, 
            amount: parseFloat(amount),
            mobile: mobile,
            provider: provider,
            status: "pending", 
            reference_id: ref,
            code: ticketCode,
            date: new Date().toLocaleString(),
            greeting: "",
            receipt_image: null 
        });

        // Send back the PayMongo link if it was generated
        res.json({ message: "Ticket Generated", code: ticketCode, reference_id: ref, checkout_url: checkoutUrl });

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

// 3. Cashier Approves OTP (For Manual Cash-In)
app.post("/merchant/confirm", (req, res) => {
    const { pin, code } = req.body;
    if (pin !== MERCHANT_PIN) return res.status(401).json({ error: "Unauthorized" });

    const tx = transactions.find(t => t.code === code && t.status === "pending");
    if (!tx) return res.status(404).json({ error: "Invalid or expired Ticket Code" });

    tx.status = "approved"; 
    res.json({ message: "Approved successfully", receipt: tx });
});

// 4. Cashier Sends Final Receipt + Greeting + IMAGE (For Manual Cash-In)
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

// 5. NEW: PayMongo Webhook Listener
app.post("/paymongo-webhook", (req, res) => {
    const event = req.body;

    // Check if the payment was successful
    if (event.data && event.data.attributes && event.data.attributes.type === "link.payment.paid") {
        
        // Find the transaction using the hidden remarks tag
        const refId = event.data.attributes.data.attributes.remarks;
        const tx = transactions.find(t => t.reference_id === refId && t.status === "pending");

        if (tx) {
            tx.status = "completed"; // This instantly tells the customer tablet it's done!
            tx.greeting = "Payment automatically verified via PayMongo!";
            console.log(`[SUCCESS] PayMongo payment received for REF: ${refId}`);
        }
    }
    
    res.sendStatus(200); // Always reply 200 OK so PayMongo knows we got the message
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});