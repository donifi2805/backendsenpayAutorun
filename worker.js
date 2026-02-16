const admin = require('firebase-admin');

// --- 1. SETUP FIREBASE ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
} catch (error) {
    console.error("GAGAL SETUP FIREBASE:", error.message);
    process.exit(1);
}

const db = admin.firestore();

// --- 2. KONFIGURASI PROVIDER ---
const KHFY_BASE_URL = "https://panel.khfy-store.com/api_v2";
const KHFY_AKRAB_URL = "https://panel.khfy-store.com/api_v3/cek_stock_akrab";
const ICS_BASE_URL = "https://api.ics-store.my.id/api/reseller";

const KHFY_KEY = process.env.KHFY_KEY || "8F1199C1-483A-4C96-825E-F5EBD33AC60A"; 
const ICS_KEY = process.env.ICS_KEY || "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77"; 

const TG_TOKEN = "8515059248:AAGCbH_VlXUDsWn7ZVSIsFLEL7qdi6Zw7k";
const TG_CHAT_ID = "7851913065";

const KHFY_SPECIAL_CODES = ['XLA14', 'XLA32', 'XLA39', 'XLA51', 'XLA65', 'XLA89'];
const PRODUCT_NAMES = {
    'XLA14': 'Super Mini', 'XLA32': 'Mini', 'XLA39': 'Big',
    'XLA51': 'Jumbo V2', 'XLA65': 'Jumbo', 'XLA89': 'Mega Big'
};

// --- HELPERS ---
function getWIBTime() {
    return new Date().toLocaleTimeString('id-ID', { 
        timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' 
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
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: 'HTML', disable_notification: !isUrgent })
        });
    } catch (e) { }
}

async function getKHFYFullStock() {
    try {
        const response = await fetch(`${KHFY_BASE_URL}/list_product?api_key=${KHFY_KEY}`);
        const json = await response.json(); 
        let dataList = json?.data || json || [];
        const stockMap = {};
        dataList.forEach(item => { 
            stockMap[item.kode_produk] = { 
                gangguan: item.gangguan == 1, kosong: item.kosong == 1, 
                status: item.status, name: item.nama_produk, code: item.kode_produk 
            }; 
        });
        return { list: dataList, map: stockMap };
    } catch (error) { return { error: error.message }; }
}

async function getICSFullStock() {
    try {
        const response = await fetch(`${ICS_BASE_URL}/products?apikey=${ICS_KEY}`, { 
            headers: { 'Authorization': `Bearer ${ICS_KEY}`, 'Accept': 'application/json' } 
        });
        const json = await response.json(); 
        let dataList = json?.ready || json?.data || json || [];
        const stockMap = {};
        dataList.forEach(item => { 
            stockMap[item.code] = { 
                gangguan: item.status === 'gangguan' || item.status === 'error', 
                kosong: item.status === 'empty' || item.stock === 0 || item.status === 'kosong', 
                real_stock: item.stock || 0, name: item.name, code: item.code
            }; 
        });
        return { list: dataList, map: stockMap };
    } catch (error) { return { list: [], map: {} }; }
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

const formatCompact = (item, source) => {
    let statusStr = ""; let icon = "⚪";
    if (source === 'ICS') {
        const stock = (item.stock !== undefined) ? item.stock : 0;
        if (item.status === 'gangguan' || item.status === 'error') { icon = "⛔"; statusStr = "0"; } 
        else if (item.status === 'empty' || stock === 0 || item.status === 'kosong') { icon = "🔴"; statusStr = "0"; } 
        else { icon = "✅"; statusStr = `(${stock})`; } 
    } else {
        if (item.gangguan == 1) { icon = "⛔"; statusStr = "0"; }
        else if (item.kosong == 1) { icon = "🔴"; statusStr = "0"; }
        else { icon = "✅"; statusStr = "99"; } 
    }
    return `${icon} ${item.code || item.kode_produk}: <b>${statusStr}</b>`;
};

const makeTwoColumns = (list, source) => {
    let result = "";
    for (let i = 0; i < list.length; i += 2) {
        const str1 = formatCompact(list[i], source);
        const str2 = list[i + 1] ? formatCompact(list[i + 1], source) : "";
        result += `${str1}   ${str2}\n`;
    }
    return result;
};

async function hitProviderDirect(serverType, data, isRecheck = false) {
    let targetUrl, method = 'GET', body = null;
    let headers = { 'User-Agent': 'SenPayment-Worker', 'Accept': 'application/json' };
    if (serverType === 'ICS') {
        headers['Authorization'] = `Bearer ${ICS_KEY}`;
        if (isRecheck) { targetUrl = new URL(`${ICS_BASE_URL}/trx/${data.reffId}`); } 
        else { targetUrl = new URL(`${ICS_BASE_URL}/trx`); method = 'POST'; headers['Content-Type'] = 'application/json'; body = JSON.stringify({ product_code: data.sku, dest_number: data.tujuan, ref_id_custom: data.reffId }); }
        targetUrl.searchParams.append('apikey', ICS_KEY);
    } else {
        targetUrl = new URL(`${KHFY_BASE_URL}/${isRecheck ? 'history' : 'trx'}`); targetUrl.searchParams.append('api_key', KHFY_KEY);
        if (isRecheck) targetUrl.searchParams.append('refid', data.reffId); 
        else { targetUrl.searchParams.append('produk', data.sku); targetUrl.searchParams.append('tujuan', data.tujuan); targetUrl.searchParams.append('reff_id', data.reffId); }
    }
    try {
        const fetchOptions = { method, headers }; if (body) fetchOptions.body = body;
        const response = await fetch(targetUrl.toString(), fetchOptions);
        const text = await response.text();
        return JSON.parse(text);
    } catch (error) { return { status: false, message: "Error: " + error.message }; }
}

// ============================================================
// 🏁 LOGIKA UTAMA (WORKER)
// ============================================================
async function runPreorderQueue() {
    console.log(`[${new Date().toISOString()}] MEMULAI WORKER...`);
    
    try {
        // Robot hanya mengambil antrian dengan status PENDING
        const snapshot = await db.collection('po_akrab').where('status', '==', 'PENDING').orderBy('timestamp', 'asc').limit(50).get();

        const [khfyData, icsData, akrabSlotMap] = await Promise.all([ getKHFYFullStock(), getICSFullStock(), getKHFYAkrabSlots() ]);
        const stockMapKHFY = khfyData?.map; 
        const stockMapICS = icsData?.map;

        let reportMsg = `🤖 <b>AUTORUN SENPAYMENT</b> [${getWIBTime()}]\n================================\n`;
        reportMsg += "📊 <b>SLOT AKRAB V3</b>\n";
        if (akrabSlotMap) {
            KHFY_SPECIAL_CODES.forEach(code => {
                const slot = akrabSlotMap[code] ?? 0;
                reportMsg += `${slot > 3 ? '🟢' : '🔴'} ${PRODUCT_NAMES[code] || code}: <b>${slot}</b>\n`;
            });
        }
        reportMsg += "\n📡 <b>SERVER ICS</b>\n";
        if (icsData?.list?.length > 0) {
            const cleanIcs = icsData.list.filter(i => i.code && !i.code.toLowerCase().includes('tes')).sort((a,b) => a.code.localeCompare(b.code));
            reportMsg += makeTwoColumns(cleanIcs, 'ICS');
        }
        reportMsg += "\n📡 <b>SERVER KHFY</b>\n";
        if (khfyData?.list) {
            const khfyItems = khfyData.list.filter(i => !KHFY_SPECIAL_CODES.includes(i.kode_produk)).sort((a,b) => a.kode_produk.localeCompare(b.kode_produk));
            reportMsg += makeTwoColumns(khfyItems, 'KHFY');
        }

        await sendTelegramLog(reportMsg + "================================");

        if (snapshot.empty) { console.log("ℹ️ Antrian kosong."); return; }

        for (const docSnap of snapshot.docs) {
            const po = docSnap.data();
            const poID = docSnap.id;
            const skuProduk = po.kode_produk;
            const tujuan = po.tujuan;
            const serverType = po.provider || 'KHFY';
            const buyerName = po.username || 'User'; 
            let reffId = po.trx_id;

            let isSkip = false; let skipReason = '';

            // Proteksi Stok
            if (serverType === 'KHFY' && KHFY_SPECIAL_CODES.includes(skuProduk)) {
                if ((akrabSlotMap?.[skuProduk] ?? 0) <= 3) { isSkip = true; skipReason = 'Slot Habis'; }
            } else if (serverType === 'KHFY' && khfyData?.map?.[skuProduk]) {
                const i = khfyData.map[skuProduk]; if (i.gangguan || i.kosong || i.status === 0) { isSkip = true; skipReason = 'Stok Kosong'; }
            } else if (serverType === 'ICS' && icsData?.map?.[skuProduk]) {
                const i = icsData.map[skuProduk]; if (i.gangguan || i.kosong) { isSkip = true; skipReason = 'Stok Kosong'; }
            }

            if (isSkip) {
                await sendTelegramLog(`⛔ <b>SKIP:</b> ${skuProduk} - ${tujuan}\n💬 Alasan: ${skipReason}`);
                continue; 
            }

            let result = await hitProviderDirect(serverType, { sku: skuProduk, tujuan, reffId });
            
            // --- LOGIKA PENYEDERHANAAN STATUS ---
            let finalStatus = 'PENDING'; // Default kembali ke PENDING jika tidak sukses
            const strRes = JSON.stringify(result).toLowerCase();
            
            // Hanya ganti ke BERHASIL jika respon jelas-jelas sukses
            if (strRes.includes('sukses') || strRes.includes('berhasil')) {
                finalStatus = 'BERHASIL';
            }

            // Update Database (Hanya PENDING atau BERHASIL)
            await db.collection('po_akrab').doc(poID).update({ 
                status: finalStatus, 
                pesan_api: result.message || 'Updated', 
                sn: result.data?.sn || result.sn || '-', 
                raw_json: JSON.stringify(result) 
            });

            // Update Riwayat User
            const rSnap = await db.collection('users').doc(po.uid).collection('riwayat_transaksi').where('trx_id', '==', reffId).get();
            rSnap.forEach(async (d) => { 
                await d.ref.update({ status: finalStatus, sn: result.data?.sn || '-' }); 
            });

            await sendTelegramLog(`<b>TRX LOG:</b>\n👤 ${buyerName}\n📦 ${skuProduk}\n📱 ${tujuan}\n🏁 Status: <b>${finalStatus}</b>`);
            
            // Jeda antar transaksi agar tidak terkena limit API provider
            await new Promise(r => setTimeout(r, 5000));
        }
    } catch (error) { 
        await sendTelegramLog(`⚠️ <b>CRITICAL ERROR:</b> ${error.message}`);
    } finally {
        process.exit(0);
    }
}

runPreorderQueue();