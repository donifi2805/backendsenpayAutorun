const admin = require('firebase-admin');

// --- 1. SETUP FIREBASE DARI GITHUB SECRETS ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
} catch (error) {
    console.error("GAGAL SETUP FIREBASE. Pastikan Secret FIREBASE_SERVICE_ACCOUNT valid JSON:", error.message);
    process.exit(1);
}

const db = admin.firestore();

// --- 2. KONFIGURASI PROVIDER ---
const KHFY_BASE_URL = "https://panel.khfy-store.com/api_v2";
const KHFY_AKRAB_URL = "https://panel.khfy-store.com/api_v3/cek_stock_akrab";
const ICS_BASE_URL = "https://api.ics-store.my.id/api/reseller";

// Mengambil API Key dari Secrets (atau fallback ke key lama)
const KHFY_KEY = process.env.KHFY_KEY || "8F1199C1-483A-4C96-825E-F5EBD33AC60A"; 
const ICS_KEY = process.env.ICS_KEY || "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77"; 

// 🔥 KONFIGURASI TELEGRAM SENPAYMENT 🔥
const TG_TOKEN = "8515059248:AAGCbH_VlXUDsWn7ZVSIsFLEfL7qdi6Zw7k";
const TG_CHAT_ID = "7851913065";

// DAFTAR SLOT V3
const KHFY_SPECIAL_CODES = ['XLA14', 'XLA32', 'XLA39', 'XLA51', 'XLA65', 'XLA89'];
const PRODUCT_NAMES = {
    'XLA14': 'Super Mini', 'XLA32': 'Mini', 'XLA39': 'Big',
    'XLA51': 'Jumbo V2', 'XLA65': 'Jumbo', 'XLA89': 'Mega Big'
};

function getWIBTime() {
    return new Date().toLocaleTimeString('id-ID', { 
        timeZone: 'Asia/Jakarta', hour12: false,
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(/\./g, ':');
}

function escapeHtml(text) {
    if (!text) return text;
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramLog(message, isUrgent = false) {
    if (!TG_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TG_CHAT_ID, text: message, parse_mode: 'HTML', disable_notification: !isUrgent 
            })
        });
    } catch (e) { console.log("Gagal kirim Telegram:", e.message); }
}

// ============================================================
// 🛠️ FUNGSI FETCH DATA STOK
// ============================================================
async function getKHFYFullStock() {
    const params = new URLSearchParams();
    params.append('api_key', KHFY_KEY);
    try {
        const response = await fetch(`${KHFY_BASE_URL}/list_product?${params.toString()}`);
        const json = await response.json();
        let dataList = json?.data || json || [];
        const stockMap = {};
        dataList.forEach(item => {
            stockMap[item.kode_produk] = {
                gangguan: item.gangguan == 1, kosong: item.kosong == 1, 
                status: item.status, name: item.nama_produk
            };
        });
        return { list: dataList, map: stockMap };
    } catch (error) { return { error: error.message }; }
}

async function getICSFullStock() {
    const targetUrl = new URL(`${ICS_BASE_URL}/products`);
    targetUrl.searchParams.append('apikey', ICS_KEY); 
    try {
        const response = await fetch(targetUrl.toString(), {
            headers: { 'Authorization': `Bearer ${ICS_KEY}`, 'Accept': 'application/json' }
        });
        if (response.status === 401 || response.status === 403) return { list: [], map: {}, error: "Unauthorized" };
        const json = await response.json();
        let dataList = json?.ready || json?.data || json || [];
        const stockMap = {};
        dataList.forEach(item => {
            stockMap[item.code] = { 
                gangguan: item.status === 'gangguan' || item.status === 'error', 
                kosong: item.status === 'empty' || item.stock === 0 || item.status === 'kosong', 
                nonaktif: item.status === 'nonactive', real_stock: item.stock || 0,
                name: item.name, type: item.type
            };
        });
        return { list: dataList, map: stockMap };
    } catch (error) { return { list: [], map: {}, error: error.message }; }
}

async function getKHFYAkrabSlots() {
    try {
        const response = await fetch(KHFY_AKRAB_URL);
        const json = await response.json();
        const slotMap = {}; 
        if (json?.ok && Array.isArray(json.data)) {
            json.data.forEach(item => { slotMap[item.type] = parseInt(item.sisa_slot || 0); });
            return slotMap;
        }
        return null;
    } catch (error) { return null; }
}

async function hitProviderDirect(serverType, data, isRecheck = false) {
    let targetUrl, method = 'GET', body = null;
    let headers = { 'User-Agent': 'SenPayment-Worker', 'Accept': 'application/json' };

    if (serverType === 'ICS') {
        headers['Authorization'] = `Bearer ${ICS_KEY}`;
        if (isRecheck) {
            targetUrl = new URL(`${ICS_BASE_URL}/trx/${data.reffId}`);
        } else {
            targetUrl = new URL(`${ICS_BASE_URL}/trx`);
            method = 'POST';
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify({ product_code: data.sku, dest_number: data.tujuan, ref_id_custom: data.reffId });
        }
        targetUrl.searchParams.append('apikey', ICS_KEY);
    } else {
        targetUrl = new URL(`${KHFY_BASE_URL}/${isRecheck ? 'history' : 'trx'}`); 
        targetUrl.searchParams.append('api_key', KHFY_KEY);
        if (isRecheck) {
            targetUrl.searchParams.append('refid', data.reffId);
        } else {
            targetUrl.searchParams.append('produk', data.sku);
            targetUrl.searchParams.append('tujuan', data.tujuan);
            targetUrl.searchParams.append('reff_id', data.reffId);
        }
    }

    try {
        const fetchOptions = { method, headers };
        if (body) fetchOptions.body = body;
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const text = await response.text();
        if (text.trim().startsWith('<')) return { status: false, message: "HTML Error", raw: text.substring(0, 50) };
        try { return JSON.parse(text); } catch (e) { return { status: false, message: "Invalid JSON", raw: text }; }
    } catch (error) { return { status: false, message: "Timeout/Error: " + error.message }; }
}

async function sendUserLog(uid, title, message, trxId) {
    if (!uid) return;
    try {
        await db.collection('users').doc(uid).collection('notifications').add({
            title, message, type: 'transaksi', trxId, isRead: false, timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) { }
}

// ============================================================
// 🏁 LOGIKA UTAMA (WORKER)
// ============================================================
async function runPreorderQueue() {
    console.log(`[${new Date().toISOString()}] MEMULAI WORKER SENPAYMENT...`);
    await sendTelegramLog(`🤖 <b>SENPAYMENT AUTORUN START</b> [${getWIBTime()}]\n================================`);

    try {
        const snapshot = await db.collection('preorders').orderBy('timestamp', 'asc').limit(100).get();

        if (snapshot.empty) {
            console.log("ℹ️ Tidak ada antrian.");
            return;
        }

        const [khfyData, icsData, akrabSlotMap] = await Promise.all([
            getKHFYFullStock(), getICSFullStock(), getKHFYAkrabSlots()
        ]);

        const stockMapKHFY = khfyData?.map;
        const stockMapICS = icsData?.map;

        let reportMsg = "📊 <b>UPDATE STOK SENPAYMENT</b>\n";
        await sendTelegramLog(reportMsg + "<i>(Stok ditarik di background)</i>");

        for (const doc of snapshot.docs) {
            const po = doc.data();
            const poID = doc.id;
            const uidUser = po.uid; 
            const skuProduk = po.productCode || po.provider || po.code;
            const tujuan = po.targetNumber || po.target || po.tujuan;
            
            let serverType = po.serverType || (String(po.provider || "").toUpperCase().startsWith('ICS') ? 'ICS' : 'KHFY');
            let buyerName = po.username || 'User SenPayment'; 
            
            if (!skuProduk || !tujuan) { await db.collection('preorders').doc(poID).delete(); continue; }

            let isSkip = false, skipReason = '';

            // Validasi Stok
            if (serverType === 'KHFY' && KHFY_SPECIAL_CODES.includes(skuProduk)) {
                const currentSlot = akrabSlotMap ? (akrabSlotMap[skuProduk] ?? 0) : 0;
                if (currentSlot <= 3 || !akrabSlotMap) { isSkip = true; skipReason = `Slot Kosong (${currentSlot})`; }
            } else {
                if (serverType === 'KHFY' && stockMapKHFY?.[skuProduk]) {
                    const info = stockMapKHFY[skuProduk];
                    if (info.gangguan || info.kosong || info.status === 0) isSkip = true; skipReason = 'KHFY Kosong/Gangguan';
                } else if (serverType === 'ICS' && stockMapICS?.[skuProduk]) {
                    const info = stockMapICS[skuProduk];
                    if (info.gangguan || info.kosong || info.nonaktif) isSkip = true; skipReason = 'ICS Kosong/Gangguan';
                }
            }

            if (isSkip) {
                await sendTelegramLog(`⛔ SKIP: ${serverType}-${buyerName}-${skuProduk}-${tujuan} (${skipReason})`);
                continue; 
            }

            let reffId = po.active_reff_id || `${serverType}-SEN-${Date.now()}`; 
            if (!po.active_reff_id) await db.collection('preorders').doc(poID).update({ active_reff_id: reffId });

            const requestData = { sku: skuProduk, tujuan, reffId };
            let result = await hitProviderDirect(serverType, requestData, false);

            if (result?.data?.status === 'pending') {
                await new Promise(r => setTimeout(r, 6000));
                result = await hitProviderDirect(serverType, requestData, true) || result;
            }

            let isSuccess = false, isHardFail = false, finalMessage = '-', finalSN = '-', trxIdProvider = '-';

            if (serverType === 'ICS') {
                if (result.success && result.data) {
                    if (['success', 'sukses'].includes(result.data.status)) { isSuccess = true; finalMessage = result.data.message; finalSN = result.data.sn || '-'; trxIdProvider = result.data.refid || '-'; }
                    else if (['failed', 'gagal'].includes(result.data.status)) { isHardFail = true; finalMessage = result.data.message; }
                    else { finalMessage = result.data.message || 'Pending'; }
                } else { finalMessage = result.message || 'Gagal/Pending ICS'; }
            } else {
                const dataItem = Array.isArray(result.data) ? result.data[0] : result.data;
                if (result.ok && dataItem?.status_text === 'SUKSES') {
                    isSuccess = true; trxIdProvider = dataItem.kode || dataItem.trxid || '-'; finalSN = dataItem.sn || '-'; finalMessage = `${dataItem.status_text}. SN: ${finalSN}`;
                } else {
                    const msg = (result.msg || result.message || '').toLowerCase();
                    if (msg.includes('stok kosong') || msg.includes('#gagal') || dataItem?.status_text === 'GAGAL') {
                        isHardFail = true; finalMessage = dataItem?.keterangan || msg || 'Transaksi Gagal';
                    } else { finalMessage = dataItem?.keterangan || dataItem?.status_text || 'Pending'; }
                }
            }

            const jsonBlock = `\n<blockquote expandable><pre><code class="json">${escapeHtml(JSON.stringify(result, null, 2).substring(0, 1000))}</code></pre></blockquote>`;

            if (isSuccess) {
                const historyId = po.historyId || `TRX-${Date.now()}`;
                const finalTitle = po.productName || skuProduk;
                await db.collection('users').doc(uidUser).collection('history').doc(historyId).set({
                    uid: uidUser, trx_id: reffId, title: finalTitle, type: 'out', amount: po.price || 0, status: 'Sukses',
                    dest_num: tujuan, sn: finalSN, trx_id_provider: trxIdProvider, provider_code: skuProduk,
                    date: new Date().toISOString(), api_msg: finalMessage, is_preorder: true, provider_source: serverType
                });
                await sendUserLog(uidUser, "PreOrder Berhasil", `Sukses: ${finalTitle}`, historyId);
                await sendTelegramLog(`<b>LOG (${getWIBTime()})</b>\n✅ <b>SUKSES</b>\n👤 ${buyerName}\n📦 ${finalTitle}\n📱 ${tujuan}\n🧾 ${finalSN}${jsonBlock}`, true);
                await db.collection('preorders').doc(poID).delete();
            } else if (isHardFail) {
                await sendTelegramLog(`<b>LOG (${getWIBTime()})</b>\n⚠️ <b>HARD FAIL (RESET ID)</b>\n👤 ${buyerName}\n📦 ${skuProduk}\n💬 ${finalMessage}${jsonBlock}`);
                await db.collection('preorders').doc(poID).update({ active_reff_id: admin.firestore.FieldValue.delete() });
            } else {
                await sendTelegramLog(`<b>LOG (${getWIBTime()})</b>\n⏳ <b>PENDING</b>\n👤 ${buyerName}\n📦 ${skuProduk}\n💬 ${finalMessage}${jsonBlock}`);
            }
            await new Promise(r => setTimeout(r, 6000));
        }
    } catch (error) { 
        await sendTelegramLog(`⚠️ <b>CRITICAL ERROR:</b> ${error.message}`);
    } finally {
        await sendTelegramLog("================================");
        console.log("--- SELESAI ---");
        process.exit(0); // Memastikan GitHub Action berhenti dan ditandai sukses
    }
}

runPreorderQueue();