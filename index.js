const express = require("express");
const mongoose = require("mongoose");
const TelegramBot = require("node-telegram-bot-api");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const MONGO_URI = process.env.MONGO_URI;
const WEBAPP_URL = process.env.WEBAPP_URL || "";
const ADSGRAM_SECRET = process.env.ADSGRAM_SECRET;

const CHANNEL = "@alpha_ads_earn";

const AD_REWARD = 0.4;
const REFERRAL_REWARD = 3;
const MIN_WITHDRAW = 50;
const MIN_ADS = 30;

if (!BOT_TOKEN || !ADMIN_ID || !MONGO_URI) {
    console.error("Missing environment variables!");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

mongoose.connect(MONGO_URI)
    .then(() => console.log("MongoDB Connected"))
    .catch(err => console.error("MongoDB Error:", err));

const UserSchema = new mongoose.Schema({
    telegramId: { type: String, unique: true, required: true },
    username: String,
    firstName: String,
    balance: { type: Number, default: 0 },
    totalEarned: { type: Number, default: 0 },
    adsWatched: { type: Number, default: 0 },
    referrals: { type: Number, default: 0 },
    referredBy: String,
    joinedChannel: { type: Boolean, default: false }
});

const WithdrawalSchema = new mongoose.Schema({
    userId: String,
    username: String,
    amount: Number,
    method: String,
    account: String,
    status: { type: String, default: "pending" },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);
const Withdrawal = mongoose.model("Withdrawal", WithdrawalSchema);

// Verify Telegram Mini App authentication
function verifyTelegram(initData) {
    if (!initData) return null;

    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash) return null;

    params.delete("hash");

    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");

    const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(BOT_TOKEN)
        .digest();

    const calculatedHash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex");

    if (calculatedHash !== hash) return null;

    const authDate = Number(params.get("auth_date"));

    if (!authDate || Date.now() / 1000 - authDate > 86400) {
        return null;
    }

    try {
        return JSON.parse(params.get("user"));
    } catch {
        return null;
    }
}

// Authentication middleware
async function auth(req, res, next) {
    try {
        const initData = req.headers["x-telegram-init-data"];
        const tgUser = verifyTelegram(initData);

        if (!tgUser) {
            return res.status(401).json({
                success: false,
                message: "Invalid Telegram authentication"
            });
        }

        let user = await User.findOne({
            telegramId: String(tgUser.id)
        });

        if (!user) {
            user = await User.create({
                telegramId: String(tgUser.id),
                username: tgUser.username || "",
                firstName: tgUser.first_name || ""
            });
        }

        req.user = user;
        req.telegramUser = tgUser;

        next();
    } catch (error) {
        res.status(500).json({ message: "Authentication error" });
    }
}

// Check channel membership
async function checkChannel(userId) {
    try {
        const member = await bot.getChatMember(CHANNEL, userId);

        return ["creator", "administrator", "member"]
            .includes(member.status) ||
            (member.status === "restricted" && member.is_member);
    } catch (error) {
        console.log("Channel verification error:", error.message);
        return false;
    }
}

// Home
app.get("/", (req, res) => {
    res.send("Alpha Ads Earn Backend is Running!");
});

// Login / Channel verification
app.post("/api/verify-channel", auth, async (req, res) => {
    try {
        const joined = await checkChannel(req.user.telegramId);

        if (!joined) {
            return res.json({
                success: false,
                joined: false,
                message: "Please join our Telegram channel first."
            });
        }

        req.user.joinedChannel = true;
        await req.user.save();

        res.json({
            success: true,
            joined: true,
            message: "Channel verified successfully!"
        });

    } catch (error) {
        res.status(500).json({ message: "Verification failed" });
    }
});

// User information
app.get("/api/me", auth, async (req, res) => {
    const joined = await checkChannel(req.user.telegramId);

    if (!joined) {
        return res.json({
            success: false,
            joined: false
        });
    }

    res.json({
        success: true,
        user: {
            telegramId: req.user.telegramId,
            username: req.user.username,
            balance: req.user.balance,
            totalEarned: req.user.totalEarned,
            adsWatched: req.user.adsWatched,
            referrals: req.user.referrals
        }
    });
});

// AdsGram server postback
// Configure the callback URL in AdsGram if your account is eligible.
app.get("/adsgram/postback", async (req, res) => {
    try {
        if (!ADSGRAM_SECRET ||
            req.query.secret !== ADSGRAM_SECRET) {
            return res.status(403).send("Unauthorized");
        }

        const userId = String(
            req.query.userid || req.query.userId || ""
        );

        if (!/^\d+$/.test(userId)) {
            return res.status(400).send("Invalid user");
        }

        const user = await User.findOne({ telegramId: userId });

        if (!user) {
            return res.status(404).send("User not found");
        }

        user.balance += AD_REWARD;
        user.totalEarned += AD_REWARD;
        user.adsWatched += 1;

        await user.save();

        console.log("Ad reward credited:", userId);

        res.send("OK");

    } catch (error) {
        console.error(error);
        res.status(500).send("Error");
    }
});

// Referral
app.post("/api/referral", auth, async (req, res) => {
    try {
        const referralId = String(req.body.referralId || "");

        if (!/^\d+$/.test(referralId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid referral"
            });
        }

        if (referralId === req.user.telegramId) {
            return res.status(400).json({
                success: false,
                message: "You cannot refer yourself"
            });
        }

        if (req.user.referredBy) {
            return res.status(400).json({
                success: false,
                message: "Already referred"
            });
        }

        const referrer = await User.findOne({
            telegramId: referralId
        });

        if (!referrer) {
            return res.status(404).json({
                success: false,
                message: "Referrer not found"
            });
        }

        req.user.referredBy = referralId;
        await req.user.save();

        referrer.balance += REFERRAL_REWARD;
        referrer.totalEarned += REFERRAL_REWARD;
        referrer.referrals += 1;

        await referrer.save();

        res.json({
            success: true,
            message: "Referral reward added"
        });

    } catch (error) {
        res.status(500).json({ message: "Referral error" });
    }
});

// Withdrawal request
app.post("/api/withdraw", auth, async (req, res) => {
    try {
        const amount = Number(req.body.amount);
        const method = String(req.body.method || "");
        const account = String(req.body.account || "").trim();

        const joined = await checkChannel(req.user.telegramId);

        if (!joined) {
            return res.status(403).json({
                success: false,
                message: "Join our channel first"
            });
        }

        if (!Number.isFinite(amount) ||
            !Number.isInteger(amount * 100)) {
            return res.status(400).json({
                success: false,
                message: "Invalid amount"
            });
        }

        if (amount < MIN_WITHDRAW) {
            return res.status(400).json({
                success: false,
                message: "Minimum withdrawal is 50 ETB"
            });
        }

        if (req.user.adsWatched < MIN_ADS) {
            return res.status(400).json({
                success: false,
                message: "You must watch at least 30 ads"
            });
        }

        if (amount > req.user.balance) {
            return res.status(400).json({
                success: false,
                message: "Insufficient balance"
            });
        }

        if (!["Telebirr", "CBE"].includes(method)) {
            return res.status(400).json({
                success: false,
                message: "Invalid payment method"
            });
        }

        if (!account || account.length < 5 || account.length > 100) {
            return res.status(400).json({
                success: false,
                message: "Invalid account number"
            });
        }

        const pending = await Withdrawal.findOne({
            userId: req.user.telegramId,
            status: "pending"
        });

        if (pending) {
            return res.status(400).json({
                success: false,
                message: "You already have a pending withdrawal"
            });
        }

        // Reserve balance until admin decides
        const updated = await User.findOneAndUpdate(
            {
                _id: req.user._id,
                balance: { $gte: amount }
            },
            {
                $inc: { balance: -amount }
            },
            { new: true }
        );

        if (!updated) {
            return res.status(400).json({
                success: false,
                message: "Insufficient balance"
            });
        }

        const withdrawal = await Withdrawal.create({
            userId: req.user.telegramId,
            username: req.user.username,
            amount,
            method,
            account
        });

        const keyboard = {
            inline_keyboard: [[
                {
                    text: "✅ APPROVE",
                    callback_data: `approve_${withdrawal._id}`
                },
                {
                    text: "❌ REJECT",
                    callback_data: `reject_${withdrawal._id}`
                }
            ]]
        };

        try {
            await bot.sendMessage(
                ADMIN_ID,
                `💸 NEW WITHDRAWAL REQUEST

👤 User: @${req.user.username || "NoUsername"}
🆔 ID: ${req.user.telegramId}
💰 Amount: ${amount} ETB
🏦 Method: ${method}
📱 Account: ${account}
📊 Ads Watched: ${req.user.adsWatched}

Status: PENDING`,
                { reply_markup: keyboard }
            );
        } catch (error) {
            // Refund if admin notification fails
            updated.balance += amount;
            await updated.save();

            withdrawal.status = "failed";
            await withdrawal.save();

            return res.status(500).json({
                success: false,
                message: "Could not notify admin. Balance refunded."
            });
        }

        res.json({
            success: true,
            message: "Withdrawal sent to admin successfully"
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Withdrawal error" });
    }
});

// Admin approve / reject
bot.on("callback_query", async (query) => {
    try {
        if (String(query.from.id) !== ADMIN_ID) {
            return bot.answerCallbackQuery(query.id, {
                text: "You are not authorized!",
                show_alert: true
            });
        }

        const data = query.data || "";

        if (!data.startsWith("approve_") &&
            !data.startsWith("reject_")) {
            return;
        }

        const [action, withdrawalId] = data.split("_");

        const withdrawal = await Withdrawal.findById(withdrawalId);

        if (!withdrawal || withdrawal.status !== "pending") {
            return bot.answerCallbackQuery(query.id, {
                text: "This request has already been processed."
            });
        }

        const user = await User.findOne({
            telegramId: withdrawal.userId
        });

        if (!user) {
            return bot.answerCallbackQuery(query.id, {
                text: "User not found!"
            });
        }

        if (action === "approve") {
            withdrawal.status = "approved";
            await withdrawal.save();

            await bot.editMessageText(
                `✅ WITHDRAWAL APPROVED

👤 User ID: ${withdrawal.userId}
💰 Amount: ${withdrawal.amount} ETB
🏦 Method: ${withdrawal.method}
📱 Account: ${withdrawal.account}

Please complete the payment.`,
                {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                }
            );

            await bot.sendMessage(
                withdrawal.userId,
                `✅ Your withdrawal of ${withdrawal.amount} ETB has been approved!`
            );

        } else {
            withdrawal.status = "rejected";
            await withdrawal.save();

            // Return money to user's balance
            user.balance += withdrawal.amount;
            await user.save();

            await bot.editMessageText(
                `❌ WITHDRAWAL REJECTED

👤 User ID: ${withdrawal.userId}
💰 Amount: ${withdrawal.amount} ETB

💵 ${withdrawal.amount} ETB returned to user's balance.`,
                {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                }
            );

            await bot.sendMessage(
                withdrawal.userId,
                `❌ Your withdrawal was rejected.

💰 ${withdrawal.amount} ETB has been returned to your balance.`
            );
        }

        await bot.answerCallbackQuery(query.id, {
            text: action === "approve" ? "Approved!" : "Rejected!"
        });

    } catch (error) {
        console.error("Admin action error:", error);
    }
});

// Admin command
bot.onText(/\/admin/, async (msg) => {
    if (String(msg.from.id) !== ADMIN_ID) return;

    const users = await User.countDocuments();
    const withdrawals = await Withdrawal.countDocuments({
        status: "pending"
    });

    const totalBalance = await User.aggregate([
        { $group: { _id: null, total: { $sum: "$balance" } } }
    ]);

    bot.sendMessage(
        ADMIN_ID,
        `👑 ALPHA ADS EARN ADMIN

👥 Total Users: ${users}
💸 Pending Withdrawals: ${withdrawals}
💰 User Balances: ${totalBalance[0]?.total || 0} ETB`
    );
});

// Bot start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;

    const keyboard = {
        inline_keyboard: [
            [{
                text: "📢 JOIN OUR CHANNEL",
                url: "https://t.me/alpha_ads_earn"
            }],
            ...(WEBAPP_URL ? [[{
                text: "🚀 OPEN ALPHA ADS EARN",
                web_app: { url: WEBAPP_URL }
            }]] : [])
        ]
    };

    bot.sendMessage(
        chatId,
        `🔵 Welcome to ALPHA ADS EARN!

📢 Join our official channel.
✅ Verify your membership inside the Mini App.
💰 Earn rewards by watching eligible ads.`,
        { reply_markup: keyboard }
    );
});

app.listen(PORT, () => {
    console.log(`Alpha Ads Earn running on port ${PORT}`);
});
