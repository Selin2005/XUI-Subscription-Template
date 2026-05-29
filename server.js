process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import express from "express";
import fetch from "node-fetch";
import qs from "querystring";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { toJalaali } from "jalaali-js";
import https from 'https';
import http from 'http';
import speakeasy from 'speakeasy';

const app = express();
app.set('trust proxy', true);

const CONFIG_FILE_NAME = "dvhost.config";
const BROWSER_KEYWORDS = ['Mozilla', 'Chrome', 'Safari', 'Edge', 'Opera', 'Firefox', 'Trident', 'WebKit'];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const loadConfig = () => {
    const configFile = path.join(__dirname, CONFIG_FILE_NAME);
    if (!fs.existsSync(configFile)) {
        console.error("Error: Configuration file 'dvhost.config' not found!");
        process.exit(1);
    }

    return fs.readFileSync(configFile, "utf-8")
        .split("\n")
        .reduce((acc, line) => {
            const separatorIndex = line.indexOf('=');
            if (separatorIndex !== -1) {
                const key = line.substring(0, separatorIndex).trim();
                let value = line.substring(separatorIndex + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.substring(1, value.length - 1);
                }
                if (key) acc[key] = value;
            }
            return acc;
        }, {});
};

const config = loadConfig();

const {
    HOST: dvhost_host = 'localhost',
    PORT: dvhost_port = '8080',
    PATH: dvhost_path = '',
    USERNAME = '',
    PASSWORD = '',
    PROTOCOL = 'http',
    SUBSCRIPTION = '',
    PUBLIC_KEY_PATH = '',
    PRIVATE_KEY_PATH = '',
    TEMPLATE_NAME = 'default',
    DEFAULT_LANG = 'en',
    SUB_HTTP_PORT = '3000',
    SUB_HTTPS_PORT = '443',
    TELEGRAM_URL = '',
    WHATSAPP_URL = '',
    Backup_link: BACKUP_LINK = '',
    TOTP_SECRET = '',
    TWO_FACTOR = 'false',
    API_TOKEN = '',
    LOW_DATA_WARNING_MB = '0',
    LOW_TIME_WARNING_DAYS = '0',
    ANNOUNCEMENTS = ''
} = config;

// Parse announcements
// Format: type:date:message|type:message
let parsedAnnouncements = [];
if (ANNOUNCEMENTS && ANNOUNCEMENTS.trim() !== '') {
    const parts = ANNOUNCEMENTS.split('|');
    parts.forEach(part => {
        const subParts = part.split(':');
        if (subParts.length >= 2) {
            const type = subParts[0].trim();
            let date = '';
            let message = '';
            
            if (subParts.length >= 3 && /^[\d/.-]{5,15}$/.test(subParts[1].trim())) {
                date = subParts[1].trim();
                message = subParts.slice(2).join(':').trim();
            } else {
                message = subParts.slice(1).join(':').trim();
            }
            
            parsedAnnouncements.push({ type, date, message });
        }
    });
}

const convertToJalali = (timestamp) => {
    const date = new Date(timestamp);
    const { jy, jm, jd } = toJalaali(date.getFullYear(), date.getMonth() + 1, date.getDate());
    return `${jy}/${jm}/${jd}`;
};

const isBrowserRequest = (userAgent = '') =>
    BROWSER_KEYWORDS.some(keyword => userAgent.includes(keyword));

app.use(express.static(path.join(__dirname, "public")));
app.set("views", path.join(__dirname, `views/templates/${TEMPLATE_NAME}`));
app.set("view engine", "ejs");

const fetchWithRetry = async (url, options, retries = 3) => {
    try {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`Request failed with status ${response.status} for URL: ${url}`);
        return response;
    } catch (error) {
        if (retries <= 0) throw error;
        return fetchWithRetry(url, options, retries - 1);
    }
};

app.get(`/${SUBSCRIPTION.split('/')[3]}/:subId`, async (req, res) => {
    try {
        const { subId: targetSubId } = req.params;
        const userAgent = req.headers['user-agent'] || '';

        let apiHeaders = { "Accept": "application/json" };
        let suburl_content;

        if (API_TOKEN) {
            apiHeaders["Authorization"] = `Bearer ${API_TOKEN}`;
            suburl_content = await fetchUrlContent(`${SUBSCRIPTION}${targetSubId}`);
        } else {
            let loginPayload = {
                username: USERNAME,
                password: PASSWORD
            };

            if (TWO_FACTOR === 'true' && TOTP_SECRET) {
                const currentTOTP = speakeasy.totp({
                    secret: TOTP_SECRET,
                    encoding: 'base32',
                    window: 1
                });
                loginPayload.twoFactorCode = currentTOTP;
            }

            const [loginResponse, suburlContent] = await Promise.all([
                fetchWithRetry(`${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/login`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(loginPayload),
                }),
                fetchUrlContent(`${SUBSCRIPTION}${targetSubId}`)
            ]);
            
            suburl_content = suburlContent;

            if (!loginResponse.ok) throw new Error(`Login request failed. Status: ${loginResponse.status}`);

            const loginResult = await loginResponse.json();
            if (!loginResult.success) throw new Error(loginResult.msg || "Login unsuccessful");

            const cookies = loginResponse.headers.getSetCookie ? loginResponse.headers.getSetCookie() : [loginResponse.headers.get("set-cookie") || ""];
            const cookie = cookies.map(c => c ? c.split(';')[0] : "").filter(Boolean).join('; ');
            apiHeaders["cookie"] = cookie;
        }

        const listResponse = await fetchWithRetry(`${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/panel/api/inbounds/list`, {
            method: "GET",
            headers: apiHeaders
        });

        const listResult = await listResponse.json();
        if (!listResult.success) throw new Error(listResult.msg || "Failed to fetch inbounds list");

        const foundClient = listResult.obj
            .flatMap(inbound => {
                const settings = typeof inbound.settings === 'string' ? JSON.parse(inbound.settings) : inbound.settings;
                return settings.clients || [];
            })
            .find(client => client.subId === targetSubId);

        if (!foundClient) return res.status(404).json({ message: "No object found with the specified subId." });

        let trafficResponse;
        try {
            // Try the new 3X-UI standard endpoint
            trafficResponse = await fetchWithRetry(
                `${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/panel/api/clients/traffic/${foundClient.email}`, {
                method: "GET",
                headers: apiHeaders
            });
        } catch (err1) {
            try {
                // Fallback to Sanaei / Older 3X-UI standard
                trafficResponse = await fetchWithRetry(
                    `${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/panel/api/inbounds/getClientTraffics/${foundClient.email}`, {
                    method: "GET",
                    headers: apiHeaders
                });
            } catch (err2) {
                // Final fallback to alternate older 3X-UI standard
                trafficResponse = await fetchWithRetry(
                    `${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/panel/api/inbounds/clientTraffics/${foundClient.email}`, {
                    method: "GET",
                    headers: apiHeaders
                });
            }
        }

        const trafficData = await trafficResponse.json();
        
        if (!trafficData.success || !trafficData.obj) {
            trafficData.obj = {
                up: 0,
                down: 0,
                total: foundClient.totalGB || 0,
                expiryTime: foundClient.expiryTime || 0,
                enable: foundClient.enable !== false,
                email: foundClient.email
            };
        }

        const expiryTimeJalali = convertToJalali(trafficData.obj.expiryTime);
        const suburl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const suburl_base64 = Buffer.from(suburl).toString('base64');
        const decodedContent = Buffer.from(suburl_content, 'base64').toString('utf-8');
        const configs = decodedContent.split('\n').filter(line => line.trim().length > 0);

        // Sanitize social URLs so empty strings evaluate to null
        const safeWhatsApp = WHATSAPP_URL && WHATSAPP_URL.trim() !== '' ? WHATSAPP_URL.trim() : null;
        const safeTelegram = TELEGRAM_URL && TELEGRAM_URL.trim() !== '' ? TELEGRAM_URL.trim() : null;

        if (isBrowserRequest(userAgent)) {
            return res.render("sub", {
                data: {
                    ...trafficData.obj,
                    expiryTimeJalali,
                    suburl,
                    suburl_base64,
                    suburl_content,
                    configs,
                    get_backup_link: BACKUP_LINK,
                    WHATSAPP_URL: safeWhatsApp,
                    TELEGRAM_URL: safeTelegram,
                    DEFAULT_LANG,
                    ANNOUNCEMENTS: parsedAnnouncements
                },
            });
        }

        // Info Config Generation (Dummy Config)
        const totalGB = trafficData.obj.total === 0 ? "∞" : (trafficData.obj.total / 1073741824).toFixed(2) + "GB";
        const usedGB = ((trafficData.obj.up + trafficData.obj.down) / 1073741824).toFixed(2) + "GB";
        let remainingDays = "∞";
        const expiry = parseInt(trafficData.obj.expiryTime, 10);
        if (expiry > 0) {
            if (expiry > Date.now()) {
                const diffMs = expiry - Date.now();
                const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                
                if (diffDays > 0) {
                    remainingDays = diffDays + " روز";
                } else if (diffHours > 0) {
                    remainingDays = `${diffHours} ساعت و ${diffMinutes} دقیقه`;
                } else {
                    remainingDays = `${diffMinutes} دقیقه`;
                }
            } else {
                remainingDays = "منقضی";
            }
        }
        
        const dummyRemark = encodeURIComponent(`📊 ${usedGB} / ${totalGB} | ⏳ ${remainingDays}`);
        const dummyConfig = `vless://00000000-0000-0000-0000-000000000000@1.1.1.1:80?type=tcp&security=none#${dummyRemark}`;

        // Warnings Generation
        let warningConfigs = [];
        const lowDataMB = parseInt(LOW_DATA_WARNING_MB, 10) || 0;
        const remainingBytes = trafficData.obj.total - (trafficData.obj.up + trafficData.obj.down);
        if (lowDataMB > 0 && trafficData.obj.total > 0 && remainingBytes > 0 && remainingBytes <= (lowDataMB * 1024 * 1024)) {
            const dataWarningRemark = encodeURIComponent(`⚠️ هشدار: حجم شما رو به اتمام است!`);
            warningConfigs.push(`vless://00000000-0000-0000-0000-000000000001@1.1.1.1:80?type=tcp&security=none#${dataWarningRemark}`);
        }

        const lowTimeDays = parseInt(LOW_TIME_WARNING_DAYS, 10) || 0;
        if (lowTimeDays > 0 && expiry > Date.now()) {
            const diffMs = expiry - Date.now();
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

            if (diffDays >= 0 && diffDays <= lowTimeDays) {
                let timeStr = diffDays > 0 ? `${diffDays} روز` : 
                              (diffHours > 0 ? `${diffHours} ساعت و ${diffMinutes} دقیقه` : `${diffMinutes} دقیقه`);
                
                const timeWarningRemark = encodeURIComponent(`⏳ هشدار: تنها ${timeStr} تا پایان اشتراک مانده!`);
                warningConfigs.push(`vless://00000000-0000-0000-0000-000000000002@1.1.1.1:80?type=tcp&security=none#${timeWarningRemark}`);
            }
        }

        const combinedContent = [dummyConfig, ...warningConfigs, BACKUP_LINK, ...configs]
            .filter(Boolean)
            .join('\n');

        res.send(Buffer.from(combinedContent, 'utf-8').toString('base64'));
    } catch (error) {
        console.error("Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const fetchUrlContent = async function fetchUrlContent(url) {
    try {
        const isHttps = url.startsWith('https://');
        const agent = isHttps ? new https.Agent({ rejectUnauthorized: false })
            : new http.Agent();
        const response = await fetch(url, { agent });
        if (!response.ok) {
            throw new Error(`Failed to fetch URL: ${url}, Status: ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        console.error(`Error fetching URL: ${url}`, error.message);
        throw error;
    }
};

const startServers = () => {
    http.createServer(app).listen(SUB_HTTP_PORT, () => {
        console.log(`HTTP Server is running on port ${SUB_HTTP_PORT}`);
    });

    if (PUBLIC_KEY_PATH && PRIVATE_KEY_PATH &&
        fs.existsSync(PUBLIC_KEY_PATH) && fs.existsSync(PRIVATE_KEY_PATH)) {
        const options = {
            key: fs.readFileSync(PRIVATE_KEY_PATH),
            cert: fs.readFileSync(PUBLIC_KEY_PATH)
        };
        https.createServer(options, app).listen(SUB_HTTPS_PORT, () => {
            console.log(`HTTPS Server is running on port ${SUB_HTTPS_PORT}`);
        });
    } else {
        console.warn('SSL certificates not found. Only HTTP server is running.');
    }
};

startServers();
