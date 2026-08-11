import { useState, useEffect, useMemo, useCallback } from "react";
import { storageGet, storageSet } from "./supabaseClient.js";


/* ============================================================
   LINO BROW 予約アプリ
   - お客様側：法人(yoin° Beauty提携) / 個人 を選んで自動予約確定
   - 管理側：予約一覧・メニュー管理・設定・ダッシュボード
   - データは shared storage（全員で共有）に保存し、
     ダブルブッキングを防止する
   ============================================================ */

const COLORS = {
  ivory: "#F8F7F4",
  bronze: "#A78663",
  bronzeDark: "#8C6F52",
  charcoal: "#3E3E3B",
  line: "#E4DFD6",
};

const uid = (p = "") =>
  p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const pad2 = (n) => String(n).padStart(2, "0");
const toDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const weekdayJP = ["日", "月", "火", "水", "木", "金", "土"];

const DEFAULT_SETTINGS = {
  salonName: "LINO BROW",
  address: "大阪市北区堂島 ○-○-○ ○○ビル2F",
  phone: "06-0000-0000",
  openTime: "10:00",
  closeTime: "19:00",
  closedDates: [], // ["2026-08-15", ...]
  blockedSlots: [], // [{id, type:'recurring'|'specific', time:"12:00", date:"2026-08-20", note:"昼休み"}]
  cutoffHours: 3, // 直前予約の締切（時間前）
  confirmMessage:
    "ご予約ありがとうございます。当日はお時間の5分前にお越しください。ご不明点はお電話にてご連絡ください。",
  intakeQuestions: [
    "肌トラブル（赤み・かぶれ・炎症）が現在ありますか？",
    "アレルギー体質、または過去に施術でアレルギー反応が出たことがありますか？",
    "妊娠中、または妊娠の可能性がありますか？",
  ],
  cancelPolicyCorporate:
    "yoin° Beauty提携プログラムをご利用の法人様は、予約日の前日18時までにご連絡いただければ無料でキャンセル・変更が可能です。それ以降のキャンセルは1回分消化扱いとなります。",
  cancelPolicyIndividual:
    "ご予約の変更・キャンセルは前日18時までにご連絡ください。当日キャンセル・無断キャンセルの場合、キャンセル料が発生する場合がございます。",
  adminPasscode: "linobrow",
};

const DEFAULT_MENUS = [
  {
    id: uid("m_"),
    name: "眉ワックス・パーマ",
    duration: 60,
    price: 6600,
    description: "眉の形を整えるワックス脱毛と、毛流れを整えるブロウパーマのセットメニューです。",
    audience: "both",
    options: [
      { id: uid("o_"), name: "眉ティント追加", price: 2200 },
    ],
  },
  {
    id: uid("m_"),
    name: "フェイシャルワックス",
    duration: 60,
    price: 7700,
    description: "顔全体のうぶ毛を除去し、透明感のある肌へ導くフェイシャルワックスです。",
    audience: "both",
    options: [
      { id: uid("o_"), name: "毛穴クリア導入ケア追加", price: 1650 },
    ],
  },
];

const DEFAULT_COMPANIES = [
  { id: uid("c_"), code: "C001", name: "サンプル株式会社", notes: "", monthlyQuota: 3 },
];


async function loadCompanies() {
  return await storageGet("lb-companies");
}
async function saveCompanies(v) {
  await storageSet("lb-companies", v);
}
async function loadQuotaAdjustments() {
  return await storageGet("lb-quota-adjustments");
}
async function saveQuotaAdjustments(v) {
  await storageSet("lb-quota-adjustments", v);
}

async function loadAll() {
  const out = { settings: null, menus: null, bookings: null };
  out.settings = await storageGet("lb-settings");
  out.menus = await storageGet("lb-menus");
  out.bookings = await storageGet("lb-bookings");
  return out;
}
async function saveSettings(v) {
  await storageSet("lb-settings", v);
}
async function saveMenus(v) {
  await storageSet("lb-menus", v);
}
async function saveBookings(v) {
  await storageSet("lb-bookings", v);
}


/* ---------------- slot generation ---------------- */
function generateSlotsForDate(dateStr, settings, bookingsForDate) {
  const [oh, om] = settings.openTime.split(":").map(Number);
  const [ch, cm] = settings.closeTime.split(":").map(Number);
  const openMin = oh * 60 + om;
  const closeMin = ch * 60 + cm;
  const slots = [];
  for (let t = openMin; t + 60 <= closeMin; t += 60) {
    const h = Math.floor(t / 60);
    const m = t % 60;
    slots.push(`${pad2(h)}:${pad2(m)}`);
  }
  const taken = new Set(
    bookingsForDate.filter((b) => b.status !== "cancelled").map((b) => b.time)
  );

  const blocked = (settings.blockedSlots || []).filter(
    (bl) => bl.type === "recurring" || (bl.type === "specific" && bl.date === dateStr)
  );
  const blockedTimes = new Set(blocked.map((bl) => bl.time));

  // cutoff check (only relevant for today)
  const now = new Date();
  const isToday = toDateStr(now) === dateStr;
  const cutoffMs = settings.cutoffHours * 60 * 60 * 1000;

  return slots.map((time) => {
    let available = !taken.has(time) && !blockedTimes.has(time);
    if (available && isToday) {
      const [sh, sm] = time.split(":").map(Number);
      const slotDate = new Date(now);
      slotDate.setHours(sh, sm, 0, 0);
      if (slotDate.getTime() - now.getTime() < cutoffMs) available = false;
    }
    return { time, available };
  });
}

function yearMonthOf(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : "";
}

function computeQuota(company, yearMonth, bookings, quotaAdjustments) {
  if (!company) return null;
  const used = bookings.filter(
    (b) => b.companyCode === company.code && b.status !== "cancelled" && yearMonthOf(b.date) === yearMonth
  ).length;
  const adj = (quotaAdjustments[company.code] && quotaAdjustments[company.code][yearMonth]) || 0;
  const total = (company.monthlyQuota || 0) + adj;
  return { used, total, remaining: total - used, adj };
}

function nextDays(n, settings) {
  const days = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const ds = toDateStr(d);
    if (settings.closedDates.includes(ds)) continue;
    days.push({ dateStr: ds, label: `${d.getMonth() + 1}/${d.getDate()}`, wd: weekdayJP[d.getDay()] });
  }
  return days;
}

/* ============================================================
   ROOT APP
   ============================================================ */
export default function App() {
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [menus, setMenus] = useState(DEFAULT_MENUS);
  const [companies, setCompanies] = useState(DEFAULT_COMPANIES);
  const [quotaAdjustments, setQuotaAdjustments] = useState({});
  const [bookings, setBookings] = useState([]);
  const [view, setView] = useState("booking"); // booking | adminGate | admin

  useEffect(() => {
    (async () => {
      const data = await loadAll();
      const c = await loadCompanies();
      const q = await loadQuotaAdjustments();
      let s = data.settings || DEFAULT_SETTINGS;
      let m = data.menus || DEFAULT_MENUS;
      let comp = c || DEFAULT_COMPANIES;
      let qa = q || {};
      let b = data.bookings || [];
      setSettings(s);
      setMenus(m);
      setCompanies(comp);
      setQuotaAdjustments(qa);
      setBookings(b);
      if (!data.settings) await saveSettings(s);
      if (!data.menus) await saveMenus(m);
      if (!c) await saveCompanies(comp);
      if (!q) await saveQuotaAdjustments(qa);
      setLoading(false);
    })();
  }, []);

  const refreshBookings = useCallback(async () => {
    try {
      const r = await storageGet("lb-bookings");
      const fresh = r || [];
      setBookings(fresh);
      return fresh;
    } catch (e) {
      return bookings;
    }
  }, [bookings]);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: COLORS.ivory, color: COLORS.charcoal, fontFamily: "Georgia, serif" }}>
        読み込み中…
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: COLORS.ivory, color: COLORS.charcoal, fontFamily: "'Hiragino Sans', 'Noto Sans JP', sans-serif" }}>
      <TopBar view={view} setView={setView} salonName={settings.salonName} />
      {view === "booking" && (
        <BookingFlow
          settings={settings}
          menus={menus}
          companies={companies}
          quotaAdjustments={quotaAdjustments}
          bookings={bookings}
          refreshBookings={refreshBookings}
          setBookings={setBookings}
        />
      )}
      {view === "adminGate" && (
        <AdminGate settings={settings} onSuccess={() => setView("admin")} onCancel={() => setView("booking")} />
      )}
      {view === "admin" && (
        <AdminPanel
          settings={settings}
          setSettings={setSettings}
          menus={menus}
          setMenus={setMenus}
          companies={companies}
          setCompanies={setCompanies}
          quotaAdjustments={quotaAdjustments}
          setQuotaAdjustments={setQuotaAdjustments}
          bookings={bookings}
          setBookings={setBookings}
          refreshBookings={refreshBookings}
        />
      )}
    </div>
  );
}

function TopBar({ view, setView, salonName }) {
  return (
    <div style={{ borderBottom: `1px solid ${COLORS.line}`, padding: "18px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 22, letterSpacing: 1, color: COLORS.bronzeDark }}>
        {salonName}
      </div>
      {view === "booking" ? (
        <button onClick={() => setView("adminGate")} style={linkBtn}>スタッフ用管理画面</button>
      ) : (
        <button onClick={() => setView("booking")} style={linkBtn}>予約画面に戻る</button>
      )}
    </div>
  );
}

const linkBtn = {
  background: "none",
  border: "none",
  color: COLORS.bronze,
  fontSize: 13,
  cursor: "pointer",
  textDecoration: "underline",
  padding: 4,
};

/* ============================================================
   ADMIN GATE
   ============================================================ */
function AdminGate({ settings, onSuccess, onCancel }) {
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  return (
    <div style={{ maxWidth: 360, margin: "60px auto", padding: 24 }}>
      <h2 style={{ fontFamily: "Georgia, serif", fontSize: 20, marginBottom: 16 }}>スタッフ用パスコード</h2>
      <input
        type="password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        style={inputStyle}
        placeholder="パスコードを入力"
      />
      {err && <div style={{ color: "#B54747", fontSize: 13, marginTop: 6 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button
          style={primaryBtn}
          onClick={() => {
            if (pass === settings.adminPasscode) onSuccess();
            else setErr("パスコードが違います");
          }}
        >
          入る
        </button>
        <button style={secondaryBtn} onClick={onCancel}>戻る</button>
      </div>
    </div>
  );
}

/* ============================================================
   BOOKING FLOW (customer facing)
   ============================================================ */
function BookingFlow({ settings, menus, companies, quotaAdjustments, bookings, refreshBookings, setBookings }) {
  const [step, setStep] = useState(1);
  const [type, setType] = useState(null); // corporate | individual
  const [customerInfo, setCustomerInfo] = useState({ name: "", contact: "", phone: "", firstTime: null, companyCode: "", companyConfirmed: false });
  const [menuId, setMenuId] = useState(null);
  const [optionIds, setOptionIds] = useState([]);
  const [dateStr, setDateStr] = useState(null);
  const [time, setTime] = useState(null);
  const [intakeAnswers, setIntakeAnswers] = useState({}); // { [index]: true|false }
  const [policyAgreed, setPolicyAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(null);

  const matchedCompany = useMemo(() => {
    if (type !== "corporate" || !customerInfo.companyCode) return null;
    return companies.find((c) => c.code.trim().toLowerCase() === customerInfo.companyCode.trim().toLowerCase()) || null;
  }, [companies, type, customerInfo.companyCode]);

  const quota = useMemo(() => {
    if (!matchedCompany || !dateStr) return null;
    return computeQuota(matchedCompany, yearMonthOf(dateStr), bookings, quotaAdjustments);
  }, [matchedCompany, dateStr, bookings, quotaAdjustments]);
  const quotaBlocked = type === "corporate" && quota && quota.remaining <= 0;

  const availableMenus = useMemo(
    () => menus.filter((m) => m.audience === "both" || m.audience === type),
    [menus, type]
  );
  const selectedMenu = menus.find((m) => m.id === menuId);
  const selectedOptions = selectedMenu ? selectedMenu.options.filter((o) => optionIds.includes(o.id)) : [];
  const totalPrice =
    (selectedMenu ? selectedMenu.price : 0) + selectedOptions.reduce((s, o) => s + o.price, 0);

  const days = useMemo(() => nextDays(21, settings), [settings]);
  const bookingsForDate = bookings.filter((b) => b.date === dateStr);
  const slots = dateStr ? generateSlotsForDate(dateStr, settings, bookingsForDate) : [];

  const policyText = type === "corporate" ? settings.cancelPolicyCorporate : settings.cancelPolicyIndividual;

  async function handleSubmit() {
    setSubmitting(true);
    setError("");
    // re-fetch latest bookings to avoid race condition / double booking
    const fresh = await refreshBookings();
    const stillTaken = fresh.some(
      (b) => b.date === dateStr && b.time === time && b.status !== "cancelled"
    );
    if (stillTaken) {
      setError("大変申し訳ございません。ちょうど今その枠が埋まってしまいました。別の時間をお選びください。");
      setSubmitting(false);
      setStep(6);
      setTime(null);
      return;
    }
    if (type === "corporate" && matchedCompany) {
      const q = computeQuota(matchedCompany, yearMonthOf(dateStr), fresh, quotaAdjustments);
      if (q.remaining <= 0) {
        setError("大変申し訳ございません。今月のご予約枠に達しました。サロンまでご連絡ください。");
        setSubmitting(false);
        setStep(6);
        setTime(null);
        return;
      }
    }
    const newBooking = {
      id: uid("b_"),
      code: uid("").slice(0, 8).toUpperCase(),
      type,
      companyCode: type === "corporate" ? matchedCompany?.code || "" : "",
      companyOrName: type === "corporate" ? matchedCompany?.name || customerInfo.name : customerInfo.name,
      contactName: type === "corporate" ? customerInfo.contact : "",
      phone: customerInfo.phone,
      firstTime: customerInfo.firstTime,
      menuId,
      menuName: selectedMenu.name,
      optionIds,
      optionNames: selectedOptions.map((o) => o.name),
      price: totalPrice,
      date: dateStr,
      time,
      status: "confirmed",
      intakeFlags: Object.entries(intakeAnswers)
        .filter(([, v]) => v === true)
        .map(([i]) => settings.intakeQuestions[Number(i)]),
      createdAt: new Date().toISOString(),
    };
    const updated = [...fresh, newBooking];
    await saveBookings(updated);
    setBookings(updated);
    setConfirmed(newBooking);
    setSubmitting(false);
    setStep(8);
  }

  if (confirmed && step === 8) {
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "32px 20px" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 40 }}>◯</div>
          <h2 style={{ fontFamily: "Georgia, serif", fontSize: 22, marginTop: 8 }}>ご予約が確定しました</h2>
        </div>
        <div style={card}>
          <Row label="予約番号" value={confirmed.code} />
          <Row label="日時" value={`${confirmed.date} ${confirmed.time}〜`} />
          <Row label="メニュー" value={confirmed.menuName + (confirmed.optionNames.length ? " / " + confirmed.optionNames.join("、") : "")} />
          <Row label="料金目安" value={`¥${confirmed.price.toLocaleString()}`} />
          <Row label={confirmed.type === "corporate" ? "企業名" : "お名前"} value={confirmed.companyOrName + (confirmed.companyCode ? ` (${confirmed.companyCode})` : "")} />
        </div>
        <div style={{ ...card, marginTop: 12, fontSize: 13, lineHeight: 1.7 }}>
          <div style={{ fontWeight: "bold", marginBottom: 6 }}>{settings.salonName}</div>
          <div>{settings.address}</div>
          <div>{settings.phone}</div>
          <div style={{ marginTop: 10 }}>{settings.confirmMessage}</div>
        </div>
        <button style={{ ...primaryBtn, marginTop: 20, width: "100%" }} onClick={() => window.location.reload()}>
          閉じる
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "24px 20px 60px" }}>
      <StepDots step={step} total={7} />

      {step === 1 && (
        <StepBlock title="ご予約区分をお選びください">
          <OptionCard selected={type === "corporate"} onClick={() => setType("corporate")}>
            <div style={{ fontWeight: "bold" }}>法人のお客様</div>
            <div style={{ fontSize: 12, color: "#777", marginTop: 4 }}>yoin° Beauty提携プログラムをご利用の方</div>
          </OptionCard>
          <OptionCard selected={type === "individual"} onClick={() => setType("individual")}>
            <div style={{ fontWeight: "bold" }}>個人のお客様</div>
          </OptionCard>
          <NavButtons onNext={() => type && setStep(2)} nextDisabled={!type} />
        </StepBlock>
      )}

      {step === 2 && (
        <StepBlock title={type === "corporate" ? "企業情報をご入力ください" : "お客様情報をご入力ください"}>
          {type === "corporate" ? (
            <>
              <Field label="企業コード">
                <input
                  style={inputStyle}
                  value={customerInfo.companyCode}
                  onChange={(e) => setCustomerInfo({ ...customerInfo, companyCode: e.target.value, companyConfirmed: false })}
                  placeholder="例: C001"
                />
              </Field>
              {customerInfo.companyCode && (
                matchedCompany ? (
                  <div style={{ background: "#FBF6EF", border: `1px solid ${COLORS.bronze}`, borderRadius: 8, padding: 12, marginTop: -8, marginBottom: 14 }}>
                    <div style={{ fontSize: 13, marginBottom: 8 }}>
                      企業名: <span style={{ fontWeight: "bold", color: COLORS.bronzeDark }}>{matchedCompany.name}</span>
                    </div>
                    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={customerInfo.companyConfirmed}
                        onChange={(e) => setCustomerInfo({ ...customerInfo, companyConfirmed: e.target.checked })}
                        style={{ marginTop: 2 }}
                      />
                      <span>この企業名で間違いありません</span>
                    </label>
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: "#B54747", marginTop: -8, marginBottom: 14 }}>
                    コードが確認できませんでした。サロンよりご案内のコードをご確認いただくか、直接サロンまでご連絡ください。
                  </div>
                )
              )}
              <Field label="ご担当者名">
                <input style={inputStyle} value={customerInfo.contact} onChange={(e) => setCustomerInfo({ ...customerInfo, contact: e.target.value })} />
              </Field>
            </>
          ) : (
            <Field label="お名前">
              <input style={inputStyle} value={customerInfo.name} onChange={(e) => setCustomerInfo({ ...customerInfo, name: e.target.value })} />
            </Field>
          )}
          <Field label="お電話番号">
            <input style={inputStyle} value={customerInfo.phone} onChange={(e) => setCustomerInfo({ ...customerInfo, phone: e.target.value })} />
          </Field>
          <Field label="ご来店は初めてですか？">
            <div style={{ display: "flex", gap: 8 }}>
              <SmallToggle active={customerInfo.firstTime === true} onClick={() => setCustomerInfo({ ...customerInfo, firstTime: true })}>初めて</SmallToggle>
              <SmallToggle active={customerInfo.firstTime === false} onClick={() => setCustomerInfo({ ...customerInfo, firstTime: false })}>2回目以降</SmallToggle>
            </div>
          </Field>
          <NavButtons
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
            nextDisabled={
              type === "corporate"
                ? !matchedCompany || !customerInfo.companyConfirmed || !customerInfo.contact || !customerInfo.phone || customerInfo.firstTime === null
                : !customerInfo.name || !customerInfo.phone || customerInfo.firstTime === null
            }
          />
        </StepBlock>
      )}

      {step === 3 && (
        <StepBlock title="メニューをお選びください">
          {availableMenus.map((m) => (
            <OptionCard key={m.id} selected={menuId === m.id} onClick={() => { setMenuId(m.id); setOptionIds([]); }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div style={{ fontWeight: "bold" }}>{m.name}</div>
                <div style={{ color: COLORS.bronzeDark }}>¥{m.price.toLocaleString()}</div>
              </div>
              <div style={{ fontSize: 12, color: "#777", marginTop: 4 }}>{m.description}</div>
              <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>所要時間: {m.duration}分</div>
            </OptionCard>
          ))}
          <NavButtons onBack={() => setStep(2)} onNext={() => menuId && setStep(4)} nextDisabled={!menuId} />
        </StepBlock>
      )}

      {step === 4 && (
        <StepBlock title="オプション（任意）">
          {selectedMenu && selectedMenu.options.length > 0 ? (
            selectedMenu.options.map((o) => {
              const active = optionIds.includes(o.id);
              return (
                <OptionCard key={o.id} selected={active} onClick={() => setOptionIds(active ? optionIds.filter((id) => id !== o.id) : [...optionIds, o.id])}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <div>{o.name}</div>
                    <div style={{ color: COLORS.bronzeDark }}>+¥{o.price.toLocaleString()}</div>
                  </div>
                </OptionCard>
              );
            })
          ) : (
            <div style={{ fontSize: 13, color: "#999", padding: "8px 0" }}>オプションはありません</div>
          )}
          <NavButtons onBack={() => setStep(3)} onNext={() => setStep(5)} />
        </StepBlock>
      )}

      {step === 5 && (
        <StepBlock title="簡単な確認事項">
          {settings.intakeQuestions.map((q, i) => (
            <div key={i} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, marginBottom: 6 }}>{q}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <SmallToggle active={intakeAnswers[i] === true} onClick={() => setIntakeAnswers({ ...intakeAnswers, [i]: true })}>はい</SmallToggle>
                <SmallToggle active={intakeAnswers[i] === false} onClick={() => setIntakeAnswers({ ...intakeAnswers, [i]: false })}>いいえ</SmallToggle>
              </div>
            </div>
          ))}
          {Object.values(intakeAnswers).some((v) => v === true) && (
            <div style={{ background: "#FBF3EC", border: `1px solid ${COLORS.bronze}`, borderRadius: 8, padding: 12, fontSize: 12.5, lineHeight: 1.6, marginTop: 4 }}>
              該当する項目がございます。当日スタッフより詳しくお伺いいたしますので、あらかじめご了承ください。
            </div>
          )}
          <NavButtons onBack={() => setStep(4)} onNext={() => setStep(6)} />
        </StepBlock>
      )}

      {step === 6 && (
        <StepBlock title="ご希望の日時をお選びください">
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8 }}>
            {days.map((d) => (
              <button
                key={d.dateStr}
                onClick={() => { setDateStr(d.dateStr); setTime(null); }}
                style={{
                  flex: "0 0 auto",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${dateStr === d.dateStr ? COLORS.bronze : COLORS.line}`,
                  background: dateStr === d.dateStr ? COLORS.bronze : "#fff",
                  color: dateStr === d.dateStr ? "#fff" : COLORS.charcoal,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                <div>{d.label}</div>
                <div style={{ fontSize: 10 }}>({d.wd})</div>
              </button>
            ))}
          </div>

          {dateStr && type === "corporate" && quota && (
            <div style={{
              fontSize: 12.5, marginTop: 12, padding: 10, borderRadius: 8,
              background: quotaBlocked ? "#FBEAEA" : "#FBF6EF",
              border: `1px solid ${quotaBlocked ? "#E8C9C9" : COLORS.bronze}`,
            }}>
              {dateStr.slice(0, 7)}月のご利用枠: {quota.used} / {quota.total} 件
              {quotaBlocked && <div style={{ color: "#B54747", marginTop: 4 }}>今月のご予約枠に達しております。サロンまでご連絡ください。</div>}
            </div>
          )}

          {dateStr && !quotaBlocked && (
            <div style={{ marginTop: 16 }}>
              {slots.length === 0 && <div style={{ fontSize: 13, color: "#999" }}>この日は予約枠がありません</div>}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {slots.map((s) => (
                  <button
                    key={s.time}
                    disabled={!s.available}
                    onClick={() => setTime(s.time)}
                    style={{
                      padding: "10px 0",
                      borderRadius: 8,
                      border: `1px solid ${time === s.time ? COLORS.bronze : COLORS.line}`,
                      background: !s.available ? "#F0EEEA" : time === s.time ? COLORS.bronze : "#fff",
                      color: !s.available ? "#B7B2A8" : time === s.time ? "#fff" : COLORS.charcoal,
                      fontSize: 13,
                      cursor: s.available ? "pointer" : "not-allowed",
                      textDecoration: !s.available ? "line-through" : "none",
                    }}
                  >
                    {s.time}
                  </button>
                ))}
              </div>
            </div>
          )}
          {error && <div style={{ color: "#B54747", fontSize: 13, marginTop: 10 }}>{error}</div>}
          <NavButtons onBack={() => setStep(5)} onNext={() => time && setStep(7)} nextDisabled={!time || quotaBlocked} />
        </StepBlock>
      )}

      {step === 7 && (
        <StepBlock title="最終確認">
          <div style={card}>
            <Row label="区分" value={type === "corporate" ? "法人" : "個人"} />
            <Row label={type === "corporate" ? "企業名" : "お名前"} value={type === "corporate" ? `${matchedCompany?.name} (${matchedCompany?.code})` : customerInfo.name} />
            {type === "corporate" && <Row label="ご担当者" value={customerInfo.contact} />}
            <Row label="メニュー" value={selectedMenu.name} />
            {selectedOptions.length > 0 && <Row label="オプション" value={selectedOptions.map((o) => o.name).join("、")} />}
            <Row label="日時" value={`${dateStr} ${time}〜`} />
            <Row label="お支払い目安" value={`¥${totalPrice.toLocaleString()}`} />
          </div>
          <div style={{ ...card, marginTop: 12, fontSize: 12.5, lineHeight: 1.7, maxHeight: 160, overflowY: "auto" }}>
            <div style={{ fontWeight: "bold", marginBottom: 6 }}>キャンセルポリシー</div>
            {policyText}
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12, fontSize: 13 }}>
            <input type="checkbox" checked={policyAgreed} onChange={(e) => setPolicyAgreed(e.target.checked)} style={{ marginTop: 2 }} />
            <span>キャンセルポリシーに同意の上、予約を確定します</span>
          </label>
          {error && <div style={{ color: "#B54747", fontSize: 13, marginTop: 10 }}>{error}</div>}
          <NavButtons
            onBack={() => setStep(6)}
            onNext={handleSubmit}
            nextLabel={submitting ? "送信中…" : "予約を確定する"}
            nextDisabled={!policyAgreed || submitting}
          />
        </StepBlock>
      )}
    </div>
  );
}

/* ---- small booking-flow UI helpers ---- */
function StepDots({ step, total }) {
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 20, justifyContent: "center" }}>
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={{ width: 20, height: 3, borderRadius: 2, background: i < step ? COLORS.bronze : COLORS.line }} />
      ))}
    </div>
  );
}
function StepBlock({ title, children }) {
  return (
    <div>
      <h2 style={{ fontFamily: "Georgia, serif", fontSize: 18, marginBottom: 16 }}>{title}</h2>
      {children}
    </div>
  );
}
function OptionCard({ selected, onClick, children }) {
  return (
    <div
      onClick={onClick}
      style={{
        border: `1.5px solid ${selected ? COLORS.bronze : COLORS.line}`,
        background: selected ? "#FBF6EF" : "#fff",
        borderRadius: 10,
        padding: 14,
        marginBottom: 10,
        cursor: "pointer",
      }}
    >
      {children}
    </div>
  );
}
function SmallToggle({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 18px",
        borderRadius: 20,
        border: `1px solid ${active ? COLORS.bronze : COLORS.line}`,
        background: active ? COLORS.bronze : "#fff",
        color: active ? "#fff" : COLORS.charcoal,
        fontSize: 13,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: "#777", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${COLORS.line}`, fontSize: 13 }}>
      <div style={{ color: "#777" }}>{label}</div>
      <div style={{ fontWeight: "bold", textAlign: "right", maxWidth: "65%" }}>{value}</div>
    </div>
  );
}
function NavButtons({ onBack, onNext, nextDisabled, nextLabel = "次へ" }) {
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
      {onBack && <button style={secondaryBtn} onClick={onBack}>戻る</button>}
      <button style={{ ...primaryBtn, flex: 1, opacity: nextDisabled ? 0.4 : 1 }} disabled={nextDisabled} onClick={onNext}>
        {nextLabel}
      </button>
    </div>
  );
}

const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: `1px solid ${COLORS.line}`,
  fontSize: 14,
  boxSizing: "border-box",
};
const primaryBtn = {
  background: COLORS.bronze,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "12px 20px",
  fontSize: 14,
  cursor: "pointer",
};
const secondaryBtn = {
  background: "#fff",
  color: COLORS.charcoal,
  border: `1px solid ${COLORS.line}`,
  borderRadius: 8,
  padding: "12px 20px",
  fontSize: 14,
  cursor: "pointer",
};
const card = { border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: 14, background: "#fff" };

/* ============================================================
   ADMIN PANEL
   ============================================================ */
function AdminPanel({ settings, setSettings, menus, setMenus, companies, setCompanies, quotaAdjustments, setQuotaAdjustments, bookings, setBookings, refreshBookings }) {
  const [tab, setTab] = useState("bookings");
  useEffect(() => { refreshBookings(); }, []);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "16px 20px 60px" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
        {[
          ["bookings", "予約一覧"],
          ["dashboard", "ダッシュボード"],
          ["menus", "メニュー管理"],
          ["companies", "企業マスタ"],
          ["settings", "設定"],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            style={{
              padding: "8px 14px",
              borderRadius: 20,
              border: `1px solid ${tab === k ? COLORS.bronze : COLORS.line}`,
              background: tab === k ? COLORS.bronze : "#fff",
              color: tab === k ? "#fff" : COLORS.charcoal,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "bookings" && <BookingsTab bookings={bookings} setBookings={setBookings} refreshBookings={refreshBookings} />}
      {tab === "dashboard" && <DashboardTab bookings={bookings} />}
      {tab === "menus" && <MenusTab menus={menus} setMenus={setMenus} />}
      {tab === "companies" && <CompaniesTab companies={companies} setCompanies={setCompanies} bookings={bookings} quotaAdjustments={quotaAdjustments} setQuotaAdjustments={setQuotaAdjustments} />}
      {tab === "settings" && <SettingsTab settings={settings} setSettings={setSettings} />}
    </div>
  );
}

/* ---------- Companies tab ---------- */
function CompaniesTab({ companies, setCompanies, bookings, quotaAdjustments, setQuotaAdjustments }) {
  const [monthByCompany, setMonthByCompany] = useState({});
  const nowYM = yearMonthOf(toDateStr(new Date()));

  async function persist(updated) {
    setCompanies(updated);
    await saveCompanies(updated);
  }
  function nextCode() {
    const nums = companies
      .map((c) => parseInt((c.code.match(/\d+/) || [0])[0], 10))
      .filter((n) => !isNaN(n));
    const max = nums.length ? Math.max(...nums) : 0;
    return "C" + String(max + 1).padStart(3, "0");
  }
  function addCompany() {
    persist([...companies, { id: uid("c_"), code: nextCode(), name: "新規企業", notes: "", monthlyQuota: 3 }]);
  }
  function updateCompany(id, patch) {
    persist(companies.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  function deleteCompany(id) {
    persist(companies.filter((c) => c.id !== id));
  }
  async function adjustQuota(code, ym, delta) {
    const current = (quotaAdjustments[code] && quotaAdjustments[code][ym]) || 0;
    const updated = {
      ...quotaAdjustments,
      [code]: { ...(quotaAdjustments[code] || {}), [ym]: current + delta },
    };
    setQuotaAdjustments(updated);
    await saveQuotaAdjustments(updated);
  }

  return (
    <div>
      <div style={{ fontSize: 12.5, color: "#777", marginBottom: 12, lineHeight: 1.6 }}>
        法人のお客様には、ここで発行した「企業コード」をご案内ください。予約フォームではこのコードで企業を照合するため、表記ゆれなく集計できます。月間予約可能数は基本枠で、キャンセル分の再付与などは月ごとに個別調整できます。
      </div>
      <button style={{ ...primaryBtn, marginBottom: 14 }} onClick={addCompany}>+ 企業を追加</button>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {companies.map((c) => {
          const ym = monthByCompany[c.id] || nowYM;
          const q = computeQuota(c, ym, bookings, quotaAdjustments);
          return (
            <div key={c.id} style={card}>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <Field label="企業コード">
                    <input style={inputStyle} value={c.code} onChange={(e) => updateCompany(c.id, { code: e.target.value })} />
                  </Field>
                </div>
                <div style={{ flex: 2 }}>
                  <Field label="企業名">
                    <input style={inputStyle} value={c.name} onChange={(e) => updateCompany(c.id, { name: e.target.value })} />
                  </Field>
                </div>
              </div>
              <Field label="月間予約可能数（基本枠）">
                <input
                  type="number"
                  style={{ ...inputStyle, maxWidth: 120 }}
                  value={c.monthlyQuota ?? 0}
                  onChange={(e) => updateCompany(c.id, { monthlyQuota: Number(e.target.value) })}
                />
              </Field>
              <Field label="備考">
                <input style={inputStyle} value={c.notes} onChange={(e) => updateCompany(c.id, { notes: e.target.value })} />
              </Field>

              <div style={{ background: "#FAF9F6", border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 10, marginTop: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: "#777" }}>対象月:</span>
                  <input
                    type="month"
                    style={{ ...inputStyle, maxWidth: 150, padding: "6px 8px" }}
                    value={ym}
                    onChange={(e) => setMonthByCompany({ ...monthByCompany, [c.id]: e.target.value })}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 13 }}>
                    利用状況: <b>{q.used}</b> / {q.total} 件（基本{c.monthlyQuota ?? 0} {q.adj !== 0 ? (q.adj > 0 ? `+${q.adj}` : q.adj) : ""}）
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button style={secondaryBtn} onClick={() => adjustQuota(c.code, ym, -1)}>ー 枠を減らす</button>
                    <button style={primaryBtn} onClick={() => adjustQuota(c.code, ym, 1)}>＋ 枠を増やす</button>
                  </div>
                </div>
              </div>

              <button style={{ ...secondaryBtn, marginTop: 10, color: "#B54747", borderColor: "#E8C9C9" }} onClick={() => deleteCompany(c.id)}>
                削除
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Bookings tab ---------- */
function BookingsTab({ bookings, setBookings, refreshBookings }) {
  const [filter, setFilter] = useState("all");
  const sorted = [...bookings].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const filtered = sorted.filter((b) => filter === "all" || b.type === filter);

  async function updateStatus(id, status) {
    const fresh = await refreshBookings();
    const updated = fresh.map((b) => (b.id === id ? { ...b, status } : b));
    await saveBookings(updated);
    setBookings(updated);
  }

  function exportCSV() {
    const header = ["予約番号", "区分", "企業コード", "名前/企業名", "担当者", "電話", "メニュー", "オプション", "料金", "日付", "時間", "ステータス", "作成日時"];
    const rows = sorted.map((b) => [
      b.code, b.type === "corporate" ? "法人" : "個人", b.companyCode || "", b.companyOrName, b.contactName, b.phone,
      b.menuName, (b.optionNames || []).join(" / "), b.price, b.date, b.time,
      b.status === "confirmed" ? "予約中" : b.status === "done" ? "来店済み" : "キャンセル",
      b.createdAt,
    ]);
    const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bookings_${toDateStr(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {[["all", "すべて"], ["corporate", "法人"], ["individual", "個人"]].map(([k, l]) => (
            <SmallToggle key={k} active={filter === k} onClick={() => setFilter(k)}>{l}</SmallToggle>
          ))}
        </div>
        <button style={secondaryBtn} onClick={exportCSV}>CSV書き出し</button>
      </div>

      {filtered.length === 0 && <div style={{ fontSize: 13, color: "#999" }}>予約がありません</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map((b) => (
          <div key={b.id} style={{ ...card, opacity: b.status === "cancelled" ? 0.5 : 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontSize: 12, color: "#999" }}>{b.date} {b.time}〜 ／ #{b.code}</div>
                <div style={{ fontWeight: "bold", marginTop: 2 }}>
                  {b.companyOrName}{b.companyCode ? `（${b.companyCode}）` : ""} {b.type === "corporate" && b.contactName ? `／${b.contactName}` : ""}
                  <span style={{ fontWeight: "normal", color: "#999", marginLeft: 6, fontSize: 12 }}>
                    {b.type === "corporate" ? "法人" : "個人"}
                  </span>
                </div>
                <div style={{ fontSize: 13, marginTop: 2 }}>{b.menuName}{b.optionNames?.length ? " / " + b.optionNames.join("、") : ""}</div>
                <div style={{ fontSize: 12, color: "#777" }}>¥{b.price?.toLocaleString()} ／ {b.phone}</div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                <select
                  value={b.status}
                  onChange={(e) => updateStatus(b.id, e.target.value)}
                  style={{ ...inputStyle, width: "auto", padding: "6px 8px", fontSize: 12 }}
                >
                  <option value="confirmed">予約中</option>
                  <option value="done">来店済み</option>
                  <option value="cancelled">キャンセル</option>
                </select>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Dashboard tab ---------- */
function DashboardTab({ bookings }) {
  const active = bookings.filter((b) => b.status !== "cancelled");
  const corporate = active.filter((b) => b.type === "corporate");
  const individual = active.filter((b) => b.type === "individual");

  const byCompany = {};
  corporate.forEach((b) => {
    const key = b.companyCode || b.companyOrName || "(不明)";
    if (!byCompany[key]) byCompany[key] = { count: 0, last: "", name: b.companyOrName, code: b.companyCode };
    byCompany[key].count += 1;
    if (b.date > byCompany[key].last) byCompany[key].last = b.date;
  });
  const companyRows = Object.entries(byCompany).sort((a, b) => b[1].count - a[1].count);

  const totalRevenue = active.reduce((s, b) => s + (b.price || 0), 0);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))", gap: 10, marginBottom: 20 }}>
        <StatCard label="来店実績（合計）" value={active.length} />
        <StatCard label="法人 来店数" value={corporate.length} />
        <StatCard label="個人 来店数" value={individual.length} />
        <StatCard label="累計売上目安" value={`¥${totalRevenue.toLocaleString()}`} />
      </div>

      <h3 style={{ fontFamily: "Georgia, serif", fontSize: 16, marginBottom: 10 }}>企業別 来店回数</h3>
      {companyRows.length === 0 && <div style={{ fontSize: 13, color: "#999" }}>法人予約はまだありません</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {companyRows.map(([key, d]) => (
          <div key={key} style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: "bold" }}>{d.name}{d.code ? `（${d.code}）` : ""}</div>
            <div style={{ fontSize: 12, color: "#777" }}>直近: {d.last}</div>
            <div style={{ fontWeight: "bold", color: COLORS.bronzeDark }}>{d.count}回</div>
          </div>
        ))}
      </div>
    </div>
  );
}
function StatCard({ label, value }) {
  return (
    <div style={{ ...card, textAlign: "center" }}>
      <div style={{ fontSize: 11, color: "#999", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: "bold", color: COLORS.bronzeDark }}>{value}</div>
    </div>
  );
}

/* ---------- Menus tab ---------- */
function MenusTab({ menus, setMenus }) {
  async function persist(updated) {
    setMenus(updated);
    await saveMenus(updated);
  }
  function addMenu() {
    persist([
      ...menus,
      { id: uid("m_"), name: "新しいメニュー", duration: 60, price: 0, description: "", audience: "both", options: [] },
    ]);
  }
  function updateMenu(id, patch) {
    persist(menus.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }
  function deleteMenu(id) {
    persist(menus.filter((m) => m.id !== id));
  }
  function addOption(menuId) {
    persist(menus.map((m) => (m.id === menuId ? { ...m, options: [...m.options, { id: uid("o_"), name: "新しいオプション", price: 0 }] } : m)));
  }
  function updateOption(menuId, optId, patch) {
    persist(menus.map((m) => (m.id === menuId ? { ...m, options: m.options.map((o) => (o.id === optId ? { ...o, ...patch } : o)) } : m)));
  }
  function deleteOption(menuId, optId) {
    persist(menus.map((m) => (m.id === menuId ? { ...m, options: m.options.filter((o) => o.id !== optId) } : m)));
  }

  return (
    <div>
      <button style={{ ...primaryBtn, marginBottom: 14 }} onClick={addMenu}>+ メニューを追加</button>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {menus.map((m) => (
          <div key={m.id} style={card}>
            <Field label="メニュー名">
              <input style={inputStyle} value={m.name} onChange={(e) => updateMenu(m.id, { name: e.target.value })} />
            </Field>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <Field label="所要時間（分）">
                  <input type="number" style={inputStyle} value={m.duration} onChange={(e) => updateMenu(m.id, { duration: Number(e.target.value) })} />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="料金（円）">
                  <input type="number" style={inputStyle} value={m.price} onChange={(e) => updateMenu(m.id, { price: Number(e.target.value) })} />
                </Field>
              </div>
            </div>
            <Field label="説明文">
              <textarea style={{ ...inputStyle, minHeight: 60 }} value={m.description} onChange={(e) => updateMenu(m.id, { description: e.target.value })} />
            </Field>
            <Field label="表示対象">
              <select style={inputStyle} value={m.audience} onChange={(e) => updateMenu(m.id, { audience: e.target.value })}>
                <option value="both">法人・個人 両方</option>
                <option value="corporate">法人のみ</option>
                <option value="individual">個人のみ</option>
              </select>
            </Field>

            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, color: "#777", marginBottom: 6 }}>オプション</div>
              {m.options.map((o) => (
                <div key={o.id} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  <input style={{ ...inputStyle, flex: 2 }} value={o.name} onChange={(e) => updateOption(m.id, o.id, { name: e.target.value })} />
                  <input type="number" style={{ ...inputStyle, flex: 1 }} value={o.price} onChange={(e) => updateOption(m.id, o.id, { price: Number(e.target.value) })} />
                  <button style={{ ...secondaryBtn, padding: "6px 10px" }} onClick={() => deleteOption(m.id, o.id)}>削除</button>
                </div>
              ))}
              <button style={{ ...secondaryBtn, fontSize: 12, padding: "6px 10px" }} onClick={() => addOption(m.id)}>+ オプション追加</button>
            </div>

            <button style={{ ...secondaryBtn, marginTop: 12, color: "#B54747", borderColor: "#E8C9C9" }} onClick={() => deleteMenu(m.id)}>
              このメニューを削除
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Settings tab ---------- */
function SettingsTab({ settings, setSettings }) {
  const [local, setLocal] = useState(settings);
  const [saved, setSaved] = useState(false);

  async function persist() {
    setSettings(local);
    await saveSettings(local);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }
  function addClosedDate(d) {
    if (!d || local.closedDates.includes(d)) return;
    setLocal({ ...local, closedDates: [...local.closedDates, d].sort() });
  }
  function removeClosedDate(d) {
    setLocal({ ...local, closedDates: local.closedDates.filter((x) => x !== d) });
  }
  const [newBlock, setNewBlock] = useState({ type: "recurring", time: "12:00", date: "", note: "" });
  function addBlockedSlot() {
    if (!newBlock.time) return;
    if (newBlock.type === "specific" && !newBlock.date) return;
    setLocal({
      ...local,
      blockedSlots: [...(local.blockedSlots || []), { id: uid("bl_"), ...newBlock }],
    });
    setNewBlock({ type: "recurring", time: "12:00", date: "", note: "" });
  }
  function removeBlockedSlot(id) {
    setLocal({ ...local, blockedSlots: local.blockedSlots.filter((b) => b.id !== id) });
  }
  function addQuestion() {
    setLocal({ ...local, intakeQuestions: [...local.intakeQuestions, ""] });
  }
  function updateQuestion(i, val) {
    const arr = [...local.intakeQuestions];
    arr[i] = val;
    setLocal({ ...local, intakeQuestions: arr });
  }
  function removeQuestion(i) {
    setLocal({ ...local, intakeQuestions: local.intakeQuestions.filter((_, idx) => idx !== i) });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={card}>
        <Field label="店舗名"><input style={inputStyle} value={local.salonName} onChange={(e) => setLocal({ ...local, salonName: e.target.value })} /></Field>
        <Field label="住所・アクセス"><input style={inputStyle} value={local.address} onChange={(e) => setLocal({ ...local, address: e.target.value })} /></Field>
        <Field label="電話番号"><input style={inputStyle} value={local.phone} onChange={(e) => setLocal({ ...local, phone: e.target.value })} /></Field>
        <Field label="予約完了メッセージ"><textarea style={{ ...inputStyle, minHeight: 60 }} value={local.confirmMessage} onChange={(e) => setLocal({ ...local, confirmMessage: e.target.value })} /></Field>
      </div>

      <div style={card}>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Field label="営業開始時間"><input type="time" style={inputStyle} value={local.openTime} onChange={(e) => setLocal({ ...local, openTime: e.target.value })} /></Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="営業終了時間"><input type="time" style={inputStyle} value={local.closeTime} onChange={(e) => setLocal({ ...local, closeTime: e.target.value })} /></Field>
          </div>
        </div>
        <Field label="直前予約の締切（何時間前まで受付するか）">
          <input type="number" style={inputStyle} value={local.cutoffHours} onChange={(e) => setLocal({ ...local, cutoffHours: Number(e.target.value) })} />
        </Field>
        <Field label="定休日・臨時休業日">
          <input type="date" style={inputStyle} onChange={(e) => addClosedDate(e.target.value)} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {local.closedDates.map((d) => (
              <span key={d} style={{ background: "#F0EEEA", padding: "4px 10px", borderRadius: 14, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                {d}
                <span style={{ cursor: "pointer", color: "#B54747" }} onClick={() => removeClosedDate(d)}>✕</span>
              </span>
            ))}
          </div>
        </Field>
      </div>

      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: "bold", marginBottom: 4 }}>予約を受け付けない時間</div>
        <div style={{ fontSize: 12, color: "#777", marginBottom: 10, lineHeight: 1.6 }}>
          定休日とは別に、特定の時間帯だけ予約を止められます（例: 毎日12:00の昼休み、特定日の15:00だけ他予定あり、など）。
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {(local.blockedSlots || []).map((b) => (
            <span key={b.id} style={{ background: "#F0EEEA", padding: "4px 10px", borderRadius: 14, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
              {b.type === "recurring" ? `毎日 ${b.time}` : `${b.date} ${b.time}`}{b.note ? `（${b.note}）` : ""}
              <span style={{ cursor: "pointer", color: "#B54747" }} onClick={() => removeBlockedSlot(b.id)}>✕</span>
            </span>
          ))}
          {(!local.blockedSlots || local.blockedSlots.length === 0) && (
            <span style={{ fontSize: 12, color: "#999" }}>設定されていません</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>種類</div>
            <select style={{ ...inputStyle, padding: "8px 8px" }} value={newBlock.type} onChange={(e) => setNewBlock({ ...newBlock, type: e.target.value })}>
              <option value="recurring">毎日繰り返し</option>
              <option value="specific">特定の日付のみ</option>
            </select>
          </div>
          {newBlock.type === "specific" && (
            <div>
              <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>日付</div>
              <input type="date" style={{ ...inputStyle, padding: "8px 8px" }} value={newBlock.date} onChange={(e) => setNewBlock({ ...newBlock, date: e.target.value })} />
            </div>
          )}
          <div>
            <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>時間</div>
            <input type="time" style={{ ...inputStyle, padding: "8px 8px" }} value={newBlock.time} onChange={(e) => setNewBlock({ ...newBlock, time: e.target.value })} />
          </div>
          <div style={{ flex: 1, minWidth: 100 }}>
            <div style={{ fontSize: 11, color: "#777", marginBottom: 4 }}>メモ（任意）</div>
            <input style={{ ...inputStyle, padding: "8px 8px" }} value={newBlock.note} onChange={(e) => setNewBlock({ ...newBlock, note: e.target.value })} placeholder="例: 昼休み" />
          </div>
          <button style={primaryBtn} onClick={addBlockedSlot}>追加</button>
        </div>
      </div>

      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: "bold", marginBottom: 8 }}>問診項目</div>
        {local.intakeQuestions.map((q, i) => (
          <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input style={inputStyle} value={q} onChange={(e) => updateQuestion(i, e.target.value)} />
            <button style={{ ...secondaryBtn, padding: "6px 10px" }} onClick={() => removeQuestion(i)}>削除</button>
          </div>
        ))}
        <button style={{ ...secondaryBtn, fontSize: 12 }} onClick={addQuestion}>+ 質問を追加</button>
      </div>

      <div style={card}>
        <Field label="キャンセルポリシー（法人向け）">
          <textarea style={{ ...inputStyle, minHeight: 90 }} value={local.cancelPolicyCorporate} onChange={(e) => setLocal({ ...local, cancelPolicyCorporate: e.target.value })} />
        </Field>
        <Field label="キャンセルポリシー（個人向け）">
          <textarea style={{ ...inputStyle, minHeight: 90 }} value={local.cancelPolicyIndividual} onChange={(e) => setLocal({ ...local, cancelPolicyIndividual: e.target.value })} />
        </Field>
      </div>

      <div style={card}>
        <Field label="スタッフ用パスコード">
          <input style={inputStyle} value={local.adminPasscode} onChange={(e) => setLocal({ ...local, adminPasscode: e.target.value })} />
        </Field>
      </div>

      <button style={primaryBtn} onClick={persist}>{saved ? "保存しました ✓" : "設定を保存する"}</button>
    </div>
  );
}
