const admin = require('firebase-admin');

// --- 1. SETUP FIREBASE DARI GITHUB SECRETS ---
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

// 🔥 KONFIGURASI TELEGRAM SENPAYMENT 🔥
const TG_TOKEN = "8515059248:AAGCbH_VlXUDsWn7ZVSIsFLEfL7qdi6Zw7k";
const TG_CHAT_ID = "7851913065";

const KHFY_SPECIAL_CODES = ['XLA14', 'XLA32', 'XLA39', 'XLA51', 'XLA65', 'XLA89'];

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
    } catch (e) { console.log("Gagal kirim Telegram:", e.message); }
}

async function getKHFYFullStock() {
    const params = new URLSearchParams(); 
    params.append('api_key', KHFY_KEY);
    try {
        const response = await fetch(`${KHFY_BASE_URL}/list_product?${params.toString()}`);
        const json = await response.json(); 
        let dataList = json?.data || json || [];
        const stockMap = {};
        dataList.forEach(item => { 
            stockMap[item.kode_produk] = { gangguan: item.gangguan == 1, kosong: item.kosong == 1, status: item.status, name: item.nama_produk }; 
        });
        return { map: stockMap };
    } catch (error) { return { error: error.message }; }
}

async function getICSFullStock() {
    const targetUrl = new URL(`${ICS_BASE_URL}/products`); 
    targetUrl.searchParams.append('apikey', ICS_KEY); 
    try {
        const response = await fetch(targetUrl.toString(), { 
            headers: { 'Authorization': `Bearer ${ICS_KEY}`, 'Accept': 'application/json' } 
        });
        const json = await response.json(); 
        let dataList = json?.ready || json?.data || json || [];
        const stockMap = {};
        dataList.forEach(item => { 
            stockMap[item.code] = { gangguan: item.status === 'gangguan' || item.status === 'error', kosong: item.status === 'empty' || item.stock === 0 || item.status === 'kosong', nonaktif: item.status === 'nonactive' }; 
        });
        return { map: stockMap };
    } catch (error) { return { map: {} }; }
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
        try { return JSON.parse(text); } catch (e) { return { status: false, message: "Invalid JSON", raw: text }; }
    } catch (error) { return { status: false, message: "Timeout/Error: " + error.message }; }
}

// ============================================================
// 🏁 LOGIKA UTAMA (WORKER)
// ============================================================
async function runPreorderQueue() {
    console.log(`[${new Date().toISOString()}] MEMULAI WORKER SENPAYMENT...`);

    try {
        const snapshot = await db.collection('po_akrab').where('status', '==', 'PENDING').orderBy('timestamp', 'asc').limit(50).get();

        if (snapshot.empty) {
            console.log("ℹ️ Tidak ada antrian PENDING.");
            return;
        }

        await sendTelegramLog(`🤖 <b>SENPAYMENT AUTORUN START</b> [${getWIBTime()}]\n================================`);

        const [khfyData, icsData, akrabSlotMap] = await Promise.all([ getKHFYFullStock(), getICSFullStock(), getKHFYAkrabSlots() ]);
        const stockMapKHFY = khfyData?.map; 
        const stockMapICS = icsData?.map;

        for (const docSnap of snapshot.docs) {
            const po = docSnap.data();
            const poID = docSnap.id;
            
            const uidUser = po.uid; 
            const skuProduk = po.kode_produk;
            const tujuan = po.tujuan;
            const serverType = po.provider || 'KHFY';
            const buyerName = po.username || 'User SenPayment'; 
            let reffId = po.trx_id;

            if (!skuProduk || !tujuan) continue;

            let isSkip = false;
            let skipReason = '';

            // Validasi Stok
            if (serverType === 'KHFY' && KHFY_SPECIAL_CODES.includes(skuProduk)) {
                const currentSlot = akrabSlotMap ? (akrabSlotMap[skuProduk] ?? 0) : 0;
                if (currentSlot <= 3 || !akrabSlotMap) { 
                    isSkip = true; 
                    skipReason = `Slot Kosong (${currentSlot})`; 
                }
            } else {
                if (serverType === 'KHFY' && stockMapKHFY?.[skuProduk]) {
                    const info = stockMapKHFY[skuProduk];
                    if (info.gangguan || info.kosong || info.status === 0) {
                        isSkip = true; 
                        skipReason = 'KHFY Kosong/Gangguan';
                    }
                } else if (serverType === 'ICS' && stockMapICS?.[skuProduk]) {
                    const info = stockMapICS[skuProduk];
                    if (info.gangguan || info.kosong || info.nonaktif) {
                        isSkip = true; 
                        skipReason = 'ICS Kosong/Gangguan';
                    }
                }
            }

            if (isSkip) {
                await sendTelegramLog(`⛔ SKIP: ${serverType}-${buyerName}-${skuProduk}-${tujuan} (${skipReason})`);
                continue; 
            }

            const requestData = { sku: skuProduk, tujuan: tujuan, reffId: reffId };
            let result = await hitProviderDirect(serverType, requestData, false);

            if (result?.data?.status === 'pending') {
                await new Promise(r => setTimeout(r, 6000));
                result = await hitProviderDirect(serverType, requestData, true) || result;
            }

            let finalStatus = 'PENDING';
            let finalMessage = '-';
            let finalSN = '-';

            // Parsing Response (Format aman dari word-wrap)
            if (serverType === 'ICS') {
                if (result.success && result.data) {
                    const stat = result.data.status;
                    if (stat === 'success' || stat === 'sukses') { 
                        finalStatus = 'BERHASIL'; 
                        finalMessage = result.data.message; 
                        finalSN = result.data.sn || '-'; 
                    } else if (stat === 'failed' || stat === 'gagal') { 
                        finalStatus = 'GAGAL'; 
                        finalMessage = result.data.message; 
                    } else { 
                        finalStatus = 'PROSES'; 
                        finalMessage = result.data.message || 'Pending'; 
                    }
                } else { 
                    finalStatus = 'GAGAL'; 
                    finalMessage = result.message || 'Gagal ICS'; 
                }
            } else {
                const strRes = JSON.stringify(result).toLowerCase();
                const dataItem = Array.isArray(result.data) ? result.data[0] : result.data;
                
                if (result.success || result.status || strRes.includes('sukses') || strRes.includes('berhasil')) {
                    finalStatus = 'BERHASIL';
                    finalMessage = dataItem?.status_text || result.message || 'Sukses';
                    finalSN = dataItem?.sn || dataItem?.keterangan || '-';
                } else if (strRes.includes('pending') || strRes.includes('proses')) {
                    finalStatus = 'PROSES';
                    finalMessage = dataItem?.keterangan || result.message || 'Pending';
                } else {
                    finalStatus = 'GAGAL';
                    finalMessage = dataItem?.keterangan || result.message || 'Transaksi Gagal';
                }
            }

            const rawJsonStr = JSON.stringify(result);
            const jsonBlock = `\n<blockquote expandable><pre><code class="json">${escapeHtml(JSON.stringify(result, null, 2).substring(0, 1000))}</code></pre></blockquote>`;

            // UPDATE KE DATABASE
            await db.collection('po_akrab').doc(poID).update({ 
                status: finalStatus, 
                pesan_api: finalMessage, 
                sn: finalSN, 
                raw_json: rawJsonStr 
            });

            const riwayatSnap = await db.collection('users').doc(uidUser).collection('riwayat_transaksi').where('trx_id', '==', reffId).get();
            riwayatSnap.forEach(async (docRef) => {
                await docRef.ref.update({ status: finalStatus, sn: finalMessage, raw_json: rawJsonStr });
            });

            // NOTIFIKASI TELEGRAM
            if (finalStatus === 'BERHASIL') {
                await sendTelegramLog(`<b>LOG (${getWIBTime()})</b>\n✅ <b>SUKSES</b>\n👤 ${buyerName}\n📦 ${skuProduk}\n📱 ${tujuan}\n🧾 ${finalSN}${jsonBlock}`, true);
            } else if (finalStatus === 'GAGAL') {
                await sendTelegramLog(`<b>LOG (${getWIBTime()})</b>\n⚠️ <b>GAGAL</b>\n👤 ${buyerName}\n📦 ${skuProduk}\n💬 ${finalMessage}${jsonBlock}`);
                await db.collection('po_akrab').doc(poID).update({ trx_id: `${serverType}-RETRY-${Date.now()}` });
            } else {
                await sendTelegramLog(`<b>LOG (${getWIBTime()})</b>\n⏳ <b>PROSES</b>\n👤 ${buyerName}\n📦 ${skuProduk}\n💬 ${finalMessage}${jsonBlock}`);
            }
            
            await new Promise(r => setTimeout(r, 6000));
        }
    } catch (error) { 
        await sendTelegramLog(`⚠️ <b>CRITICAL ERROR:</b> ${error.message}`);
    } finally {
        console.log("--- SELESAI ---");
        process.exit(0);
    }
}

runPreorderQueue();