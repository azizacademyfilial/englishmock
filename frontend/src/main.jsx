import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './admin-mobile.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const APP_VERSION = '2026-06-17-topic-mode-daily-toggle-v133';
const TOPIC_PASS_SCORE = 90;

const ADMIN_ROUTE_TABS = ['dashboard', 'centers', 'create', 'accounts', 'plans', 'enrollments', 'progress', 'certificates', 'shopOrders', 'content', 'logs', 'settings'];
function readAdminRouteFromHash() {
  const hash = String(window.location.hash || '').replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'admin' && ADMIN_ROUTE_TABS.includes(parts[1])) return parts[1];
  if (ADMIN_ROUTE_TABS.includes(parts[0])) return parts[0];
  return '';
}
function writeAdminRouteToHash(tab) {
  if (!ADMIN_ROUTE_TABS.includes(tab)) return;
  const next = `#admin/${tab}`;
  if (window.location.hash !== next) window.history.replaceState(null, '', next);
}

const storedAppVersion = localStorage.getItem('alaziz_app_version');
if (storedAppVersion !== APP_VERSION) {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  localStorage.setItem('alaziz_app_version', APP_VERSION);
}

function logoutToLogin() {
  try {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('user');
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent('auth-expired', { detail: 'Tizimdan chiqdingiz. Qayta login qiling.' }));
  } catch {}
  setTimeout(() => {
    try {
      window.location.replace(window.location.origin + window.location.pathname);
    } catch {
      window.location.reload();
    }
  }, 30);
}

function safeLogout(onLogout) {
  if (typeof onLogout === 'function') return onLogout();
  return logoutToLogin();
}


function textInitials(value = 'EM') {
  const clean = String(value || 'EM').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (!words.length) return 'EM';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.map(word => word[0]).join('').slice(0, 2).toUpperCase();
}

function panelBrand(user = {}, options = {}) {
  const isSuper = !!user?.isSuper || user?.centerId === 'all';
  const rawCenterName = String(user?.centerName || '').trim();
  const cleanedCenterName = /al\s*-?\s*aziz|mock\s+platform|main\s+center/i.test(rawCenterName)
    ? 'ENGLISH Mock'
    : rawCenterName;
  const hasRealCenter = cleanedCenterName && cleanedCenterName !== 'Barcha markazlar';
  const name = isSuper
    ? (options.superName || 'ENGLISH Mock HQ')
    : (hasRealCenter ? cleanedCenterName : (options.fallbackName || 'ENGLISH Mock'));
  return {
    name,
    subtitle: isSuper ? (options.superSubtitle || 'Multi-center control') : (options.subtitle || 'ENGLISH Mock'),
    logo: !isSuper ? (user?.centerLogoDataUrl || '') : '',
    initials: textInitials(name)
  };
}

function BrandLogo({ brand, className = 'accountBrandMark', alt = 'Markaz logo' }) {
  if (brand?.logo) return <img className={`${className} accountBrandLogo`} src={brand.logo} alt={alt} />;
  return <div className={className}>{brand?.initials || 'EM'}</div>;
}



function scrollPageToTop(behavior = 'smooth') {
  if (typeof window === 'undefined') return;
  try {
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior });
    });
  } catch {
    try { window.scrollTo(0, 0); } catch {}
  }
}


function api(path, options = {}) {
  const token = localStorage.getItem('token');
  return fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  }).then(async response => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.dispatchEvent(new CustomEvent('auth-expired', { detail: data.message || 'Sessiya tugagan. Admin qayta login qiling.' }));
      }
      throw new Error(data.message || 'Xatolik yuz berdi');
    }
    return data;
  });
}


async function fetchCertificateHtml(certificateId) {
  const token = localStorage.getItem('token');
  const response = await fetch(`${API}/api/certificates/${certificateId}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || 'Rasm yuklashda xatolik yuz berdi');
  return text;
}

function certificatePreviewHtml(html = '') {
  const previewCss = `
    body{padding:0!important;background:#fff!important;min-height:auto!important;display:block!important;overflow:hidden!important;}
    .toolbar{display:none!important;}
    .certificate-wrap{width:100%!important;min-height:0!important;border-radius:0!important;padding:8px!important;box-shadow:none!important;}
    .certificate{border-radius:10px!important;}
    @media(max-width:980px){.certificate{padding:18px 14px!important}}
  `;
  if (html.includes('</style>')) return html.replace('</style>', `${previewCss}</style>`);
  return html;
}

function certificateDownloadHtml(html = '') {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelector('.toolbar')?.remove();
    return `<!doctype html>
${doc.documentElement.outerHTML}`;
  } catch (err) {
    return html;
  }
}


function certificateImageRenderHtml(html = '') {
  const downloadCss = `
    html,body{margin:0!important;padding:0!important;background:#fff!important;min-height:auto!important;overflow:hidden!important;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}
    .toolbar{display:none!important;}
    .certificate-wrap{width:980px!important;max-width:980px!important;margin:0!important;padding:10px!important;background:#fff!important;box-shadow:none!important;}
    .certificate{border-radius:0!important;box-shadow:none!important;}
    @media(max-width:840px){.certificate-wrap{width:980px!important;max-width:980px!important}.certificate{padding:28px 34px 24px!important}.topline{grid-template-columns:1fr 150px 1fr!important}.org{order:initial!important}.logoBox{order:initial!important}.refRow{grid-template-columns:1fr 280px!important}.candidateGrid{grid-template-columns:minmax(0,1fr) 154px!important}.footer{grid-template-columns:1fr 150px 1fr!important}.scores{grid-template-columns:repeat(3,1fr)!important}.langLevelRow{grid-template-columns:1.35fr .08fr 1fr!important}.fields{grid-template-columns:280px 1fr!important}.photo{justify-self:end!important}.vSep{display:block!important}.scoreCard{border-right:1px solid #d2b177!important;border-bottom:0!important;padding-bottom:0!important}.scoreCard:last-child{border-right:0!important}}
  `;
  let result = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  if (result.includes('</style>')) result = result.replace('</style>', `${downloadCss}</style>`);
  return result;
}

function certificateFileName(certificate = {}) {
  const name = String(certificate.fullName || certificate.name || 'sertifikat')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'sertifikat';
  const level = String(certificate.level || 'certificate').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `${name}-${level}.png`;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function imageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Sertifikat rasmini yaratib bo‘lmadi'));
    img.src = url;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('PNG fayl yaratilmadi'));
    }, 'image/png', 1);
  });
}

async function downloadCertificatePngFromHtml(html, fileName) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.left = '-12000px';
  frame.style.top = '0';
  frame.style.width = '1100px';
  frame.style.height = '1500px';
  frame.style.opacity = '0';
  frame.style.pointerEvents = 'none';
  frame.style.border = '0';
  frame.style.zIndex = '-1';
  document.body.appendChild(frame);

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sertifikat yuklanmadi')), 8000);
      frame.onload = () => {
        clearTimeout(timer);
        setTimeout(resolve, 350);
      };
      frame.srcdoc = certificateImageRenderHtml(html);
    });

    const doc = frame.contentDocument || frame.contentWindow?.document;
    if (!doc) throw new Error('Sertifikat oynasi topilmadi');
    try { if (doc.fonts?.ready) await doc.fonts.ready; } catch {}

    const node = doc.querySelector('.certificate-wrap');
    if (!node) throw new Error('Sertifikat formasi topilmadi');

    const rect = node.getBoundingClientRect();
    const width = Math.ceil(node.scrollWidth || rect.width || 980);
    const height = Math.ceil(node.scrollHeight || rect.height || 1200);
    const css = Array.from(doc.querySelectorAll('style')).map(style => style.textContent || '').join('\n');
    const clone = node.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style><![CDATA[${css}]]></style>${clone.outerHTML}</div></foreignObject></svg>`;
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const svgUrl = URL.createObjectURL(svgBlob);

    try {
      const img = await imageFromUrl(svgUrl);
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      const blob = await canvasToBlob(canvas);
      downloadBlob(blob, fileName);
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  } finally {
    setTimeout(() => frame.remove(), 1000);
  }
}

function showCertificateModal(certificate, html) {
  document.getElementById('certificateModalOverlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'certificateModalOverlay';
  overlay.className = 'certificateModalOverlay';
  overlay.innerHTML = `
    <div class="certificateModalCard" role="dialog" aria-modal="true">
      <div class="certificateModalTop">
        <div>
          <b class="certificateModalTitle"></b>
          <span>Sertifikat admin panel ichida ko‘rinadi</span>
        </div>
        <div class="certificateModalActions">
          <button type="button" class="primary certificateModalDownload">⬇️ Rasm yuklash</button>
          <button type="button" class="ghost certificateModalClose">✕ Yopish</button>
        </div>
      </div>
      <iframe class="certificateModalFrame" title="Sertifikat preview"></iframe>
    </div>
  `;

  const close = () => {
    overlay.remove();
    document.body.classList.remove('certificateModalOpen');
  };

  overlay.querySelector('.certificateModalTitle').textContent = `${certificate.language?.toUpperCase?.() || certificate.languageTitle || 'Sertifikat'} ${certificate.level || ''}`.trim();
  overlay.querySelector('.certificateModalClose').addEventListener('click', close);
  overlay.querySelector('.certificateModalDownload').addEventListener('click', () => downloadCertificateFile(certificate));
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });

  document.body.appendChild(overlay);
  document.body.classList.add('certificateModalOpen');
  const frame = overlay.querySelector('.certificateModalFrame');
  frame.srcdoc = certificatePreviewHtml(html);
}

async function openCertificate(certificate) {
  try {
    const html = await fetchCertificateHtml(certificate.id);
    showCertificateModal(certificate, html);
  } catch (err) {
    alert(err.message || 'Sertifikat ochilmadi');
  }
}

async function downloadCertificateFile(certificate) {
  try {
    const html = await fetchCertificateHtml(certificate.id);
    await downloadCertificatePngFromHtml(html, certificateFileName(certificate));
  } catch (err) {
    alert(err.message || 'Rasm yuklashda xatolik');
  }
}

function CertificatePreview({ certificate, compact = false }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    fetchCertificateHtml(certificate.id)
      .then(source => { if (alive) setHtml(certificatePreviewHtml(source)); })
      .catch(err => { if (alive) setError(err.message || 'Sertifikat ko‘rinmadi'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [certificate.id]);

  return (
    <div className={`certificatePreviewCard ${compact ? 'compact' : ''}`}>
      <div className="certificatePreviewTop">
        <div>
          <b>{certificate.language?.toUpperCase()} {certificate.level}</b>
          <span>{certificate.score}% · Sertifikat rasmi</span>
        </div>
        <div className="certPreviewActions">
          <button type="button" className="primary small certificateActionBtn" onClick={() => openCertificate(certificate)}>👁️ Ko‘rish / PDF</button>
          <button type="button" className="ghost small certificateActionBtn" onClick={() => downloadCertificateFile(certificate)}>⬇️ Sertifikatni yuklab olish</button>
        </div>
      </div>
      {loading && <div className="certPreviewLoading">Sertifikat yuklanmoqda...</div>}
      {error && <div className="alert danger">{error}</div>}
      {html && <iframe className="certificateFrame" title={`Sertifikat ${certificate.code || certificate.id}`} srcDoc={html} />}
    </div>
  );
}

function CertificateTile({ certificate, showName = false }) {
  return (
    <button type="button" className="cert" onClick={() => openCertificate(certificate)}>
      <b>ENGLISH Mock</b>
      {showName && <span>{certificate.fullName}</span>}
      <span>{certificate.language?.toUpperCase()} {certificate.level}</span>
      <small>{certificate.score}% · ko‘rish yoki yuklash</small>
    </button>
  );
}

function fmtDate(value) {
  if (!value) return 'Cheklanmagan';
  try { return new Date(value).toLocaleDateString('uz-UZ'); } catch { return value; }
}

function fmtDateTime(value) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString('uz-UZ'); } catch { return value; }
}
function getInitials(value) {
  return String(value || 'AA')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'AA';
}
async function downloadAdminFile(path, fileName) {
  const token = localStorage.getItem('token');
  const response = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const blob = await response.blob();
  if (!response.ok) throw new Error('Fayl yuklanmadi');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function toneIcon(tone) {
  if (tone === 'danger') return '🔴';
  if (tone === 'warning') return '🟠';
  return '🔵';
}
function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function useIsMobile(maxWidth = 760) {
  const getMatch = () => (typeof window !== 'undefined' ? window.innerWidth <= maxWidth : false);
  const [isMobile, setIsMobile] = useState(getMatch);

  useEffect(() => {
    function onResize() {
      setIsMobile(getMatch());
    }
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [maxWidth]);

  return isMobile;
}

function cleanWritingPrompt(value = '') {
  return String(value || '').replace(/^\s*Complete:\s*/i, '').trim();
}

function writingPlaceholder(task) {
  if (task?.type === 'fill_blank') return 'yozing';
  if (task?.type === 'open_answer') return 'Javobni to‘liq gap bilan yozing...';
  if (task?.type === 'uz_to_en') return 'Inglizcha tarjimasini yozing...';
  return 'Javobni yozing...';
}

function writingSectionLabel(task) {
  if (task?.section) return task.section;
  if (task?.type === 'fill_blank') return 'Yoziladigan test';
  if (task?.type === 'sentence_generation') return 'Gap tuzish testi';
  return 'Yozma mashq';
}

function shouldShowWritingTaskHint(task) {
  // So‘z yozish / bo‘sh joyni to‘ldirish mashqlarida pastki ko‘rsatma ko‘rinmaydi.
  // Gap tuzish kabi haqiqiy yozma topshiriqlarda esa kerakli izohlar qoladi.
  return task?.type !== 'fill_blank' && Boolean(String(task?.hint || '').trim());
}

function writingSectionHelperText(section) {
  if (section === 'Gap tuzish testi') return 'Mavzuga mos to‘liq gap yozing.';
  return '';
}

function blankCountFromPrompt(prompt = '') {
  return (cleanWritingPrompt(prompt || '').match(/___/g) || []).length;
}

function splitMultiBlankAnswer(value = '', count = 1) {
  const raw = String(value || '');
  if (count <= 1) return [raw];
  let parts = raw.split('\n');

  // Eski javoblar yoki qo'lda yozilgan javoblar comma/pipe bilan kelgan bo'lsa ham ajratib olamiz.
  if (parts.length < count && /\s*[|,]\s*/.test(raw)) {
    parts = raw.split(/\s*[|,]\s*/);
  }

  while (parts.length < count) parts.push('');
  if (parts.length > count) {
    parts = [...parts.slice(0, count - 1), parts.slice(count - 1).join(' ')];
  }
  return parts.slice(0, count);
}

function joinMultiBlankAnswer(parts = []) {
  return parts.map(part => String(part || '').trim()).join('\n').trim();
}

function isWritingAnswerComplete(task, value) {
  if (task?.type === 'fill_blank') {
    const count = blankCountFromPrompt(task.prompt || '');
    if (count > 1) {
      return splitMultiBlankAnswer(value, count).every(part => String(part || '').trim());
    }
  }
  return String(value || '').trim().length > 0;
}

function countCompletedWritingAnswers(tasks = [], answers = {}) {
  return (Array.isArray(tasks) ? tasks : []).filter(task => isWritingAnswerComplete(task, (answers || {})[task.id])).length;
}

function WritingAnswerField({ task, value, onChange, autoFocus = false }) {
  const commonProps = {
    value: value || '',
    onChange: e => onChange(e.target.value),
    placeholder: writingPlaceholder(task),
    autoFocus
  };
  if (task?.type === 'fill_blank') {
    return <input className="writingInput" {...commonProps} />;
  }
  return <textarea className="writingTextarea" {...commonProps} rows={task?.type === 'open_answer' ? 5 : 3} />;
}

function WritingTaskAnswerArea({ task, value, onChange, autoFocus = false }) {
  if (task?.type === 'fill_blank') {
    const rawPrompt = cleanWritingPrompt(task.prompt || '');
    const parts = rawPrompt.split('___');
    const blankCount = Math.max(0, parts.length - 1);

    if (blankCount > 0) {
      const answerParts = splitMultiBlankAnswer(value, blankCount);
      const updateBlank = (blankIndex, nextValue) => {
        const nextParts = [...answerParts];
        nextParts[blankIndex] = nextValue;
        onChange(joinMultiBlankAnswer(nextParts));
      };

      return (
        <div className={`inlineBlankPrompt ${blankCount > 1 ? 'multiBlankPrompt' : ''}`}>
          {parts.map((part, index) => (
            <React.Fragment key={`blank-part-${index}`}>
              {part && <span>{part}</span>}
              {index < blankCount && (
                <input
                  className="inlineBlankInput"
                  value={answerParts[index] || ''}
                  onChange={e => updateBlank(index, e.target.value)}
                  placeholder={blankCount > 1 ? `${index + 1}-javob` : writingPlaceholder(task)}
                  autoFocus={autoFocus && index === 0}
                  aria-label={`${index + 1}-bo'sh joy javobi`}
                />
              )}
            </React.Fragment>
          ))}
        </div>
      );
    }

    return (
      <div className="inlineBlankPrompt">
        <span>{rawPrompt}</span>
        <input
          className="inlineBlankInput"
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          placeholder={writingPlaceholder(task)}
          autoFocus={autoFocus}
        />
      </div>
    );
  }

  return (
    <>
      <div className="translationPrompt">{task.prompt}</div>
      <WritingAnswerField
        task={task}
        value={value}
        onChange={onChange}
        autoFocus={autoFocus}
      />
    </>
  );
}

function fillPromptWithAnswer(prompt = '', answer = '') {
  const cleanPrompt = cleanWritingPrompt(prompt || '');
  if (!cleanPrompt.includes('___')) return cleanPrompt;
  const parts = cleanPrompt.split('___');
  const blankCount = Math.max(0, parts.length - 1);
  const answers = splitMultiBlankAnswer(answer, blankCount);
  return parts.map((part, index) => {
    if (index >= blankCount) return part;
    const cleanAnswer = String(answers[index] || '').trim();
    return `${part}${cleanAnswer ? `[ ${cleanAnswer} ]` : '___'}`;
  }).join('');
}

function WritingResultLine({ item, index }) {
  const rawAnswer = String(item.answer || '').trim();
  const userAnswer = rawAnswer === 'Javob yozilmagan' ? '' : rawAnswer;
  const expected = String(item.expected || '').trim();
  const hasInlineBlank = cleanWritingPrompt(item.prompt || '').includes('___');
  const shownPrompt = hasInlineBlank ? fillPromptWithAnswer(item.prompt, userAnswer) : cleanWritingPrompt(item.prompt);
  return (
    <div className={`writingResultItem ${item.ok ? 'ok' : 'bad'}`} key={item.id || index}>
      <div className="writingResultContent">
        <b>{index + 1}. {cleanWritingPrompt(item.prompt)}</b>
        <span className="writtenSentence"><mark>{shownPrompt}</mark></span>
        <span><b className="answerText">{userAnswer || 'Javob yozilmagan'}</b></span>
        {hasInlineBlank && expected && <span>Javob: <b className="expectedText">{expected}</b></span>}
      </div>
      <strong>{item.score}%</strong>
    </div>
  );
}


function ChoiceResultLine({ item, index }) {
  const chosen = String(item?.chosen || 'Tanlanmagan').trim();
  const correct = String(item?.correct || '').trim();
  const isOk = Boolean(item?.ok);
  return (
    <div className={`choiceResultItem ${isOk ? 'ok' : 'bad'}`} key={`${item?.question || 'choice'}-${index}`}>
      <div className="choiceResultContent">
        <b>{index + 1}. {item?.question}</b>
        <div className="choiceAnswerRows">
          <span className={`choiceAnswerPill ${isOk ? 'ok' : 'bad'}`}>Tanlangan: <b>{chosen || 'Tanlanmagan'}</b></span>
          {!isOk && correct && <span className="choiceAnswerPill correct">Kerakli javob: <b>{correct}</b></span>}
          {isOk && <span className="choiceAnswerPill correct">To‘g‘ri</span>}
        </div>
      </div>
      <strong>{isOk ? '✅' : '❌'}</strong>
    </div>
  );
}

function ChoiceResultList({ details = [], title = 'Tanlash mashqi javoblari' }) {
  const items = Array.isArray(details) ? details : [];
  if (!items.length) return null;
  const correctCount = items.filter(item => item?.ok).length;
  return (
    <div className="choiceResultList">
      <div className="choiceResultHead">
        <h3>{title}</h3>
        <span>{correctCount}/{items.length} ta to‘g‘ri</span>
      </div>
      {items.map((item, index) => <ChoiceResultLine item={item} index={index} key={`${item?.question || 'choice'}-${index}`} />)}
    </div>
  );
}


function writingResultSectionName(item) {
  const section = String(item?.section || '').trim();
  if (section) return section;
  if (item?.type === 'sentence_generation') return 'Gap tuzish testi';
  if (item?.type === 'fill_blank') return 'Yoziladigan test';
  return 'Yozma mashq';
}

function groupWritingDetailsByExercise(details = []) {
  const groups = [];
  (Array.isArray(details) ? details : []).forEach(item => {
    const title = writingResultSectionName(item);
    let group = groups.find(g => g.title === title);
    if (!group) {
      group = { title, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  });
  return groups;
}

function ResultExerciseCard({ title, subtitle, details = [], kind = 'choice' }) {
  const items = Array.isArray(details) ? details : [];
  if (!items.length) return null;
  const correctCount = items.filter(item => Boolean(item?.ok)).length;
  return (
    <section className={`resultExerciseCard ${kind === 'writing' ? 'writingExerciseCard' : 'choiceExerciseCard'}`}>
      <div className="resultExerciseHead">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <span>{correctCount}/{items.length} ta to‘g‘ri</span>
      </div>
      <div className="resultQuestionCards">
        {items.map((item, index) => kind === 'writing'
          ? <WritingResultLine item={item} index={index} key={item.id || `${title}-${index}`} />
          : <ChoiceResultLine item={item} index={index} key={`${item?.question || title}-${index}`} />
        )}
      </div>
    </section>
  );
}

function WritingResultGroups({ details = [], startNumber = 1 }) {
  const groups = groupWritingDetailsByExercise(details);
  if (!groups.length) return null;
  return (
    <div className="resultExerciseGrid">
      {groups.map((group, index) => (
        <ResultExerciseCard
          key={group.title}
          title={`${startNumber + index}-mashq: ${group.title}`}
          subtitle={group.title === 'Gap tuzish testi' ? 'Savolda qanday gap so‘ralsa, aynan shu turdagi gap yozilishi kerak.' : 'Har bir javob alohida tekshirildi.'}
          details={group.items}
          kind="writing"
        />
      ))}
    </div>
  );
}

function PracticeResultCards({ choiceDetails = [], writingDetails = [], hasWriting = false }) {
  const writingGroups = groupWritingDetailsByExercise(writingDetails);
  return (
    <div className="resultExerciseGrid">
      <ResultExerciseCard
        title="1-mashq: Tanlash savollari"
        subtitle="Variantli test savollari. To‘g‘ri va noto‘g‘ri javoblar alohida ko‘rsatiladi."
        details={choiceDetails}
        kind="choice"
      />
      {hasWriting && writingGroups.map((group, index) => (
        <ResultExerciseCard
          key={group.title}
          title={`${index + 2}-mashq: ${group.title}`}
          subtitle={group.title === 'Gap tuzish testi' ? 'Bu cardlarda o‘quvchi yozgan gap, talab va ball ko‘rinadi.' : 'Input/bo‘sh joy javoblari cardlarda ko‘rinadi.'}
          details={group.items}
          kind="writing"
        />
      ))}
    </div>
  );
}

function QuestionBlock({ q, index, answer, onAnswer, compact = false }) {
  return (
    <div className={`question ${compact ? 'mobileQuestionSlide' : ''}`} key={q.id}>
      <h3>{index + 1}. {q.question}</h3>
      <div className="options">
        {q.options.map((option, optionIndex) => (
          <label key={option} className={answer === optionIndex ? 'selected' : ''}>
            <input type="radio" name={q.id} checked={answer === optionIndex} onChange={() => onAnswer(q, optionIndex, index)} />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function MobileQuestionSwiper({ questions, answers, onAnswer, activeIndex, setActiveIndex, title = 'Savol' }) {
  const safeIndex = Math.min(activeIndex, Math.max(0, questions.length - 1));
  const current = questions[safeIndex];
  if (!current) return <div className="empty">Savollar topilmadi</div>;

  return (
    <div className="mobileTestSwiper">
      <div className="mobileSwiperTop">
        <button type="button" className="small" onClick={() => setActiveIndex(Math.max(0, safeIndex - 1))} disabled={safeIndex === 0}>← Oldingi</button>
        <strong>{title} {safeIndex + 1}/{questions.length}</strong>
        <button type="button" className="small" onClick={() => setActiveIndex(Math.min(questions.length - 1, safeIndex + 1))} disabled={safeIndex === questions.length - 1}>Keyingi →</button>
      </div>
      <div className="mobileDots" aria-label="Savollar holati">
        {questions.map((q, i) => (
          <button
            type="button"
            key={q.id}
            className={`${i === safeIndex ? 'active' : ''} ${answers[q.id] !== undefined ? 'done' : ''}`}
            onClick={() => setActiveIndex(i)}
            aria-label={`${i + 1}-savol`}
          >
            {i + 1}
          </button>
        ))}
      </div>
      <QuestionBlock q={current} index={safeIndex} answer={answers[current.id]} onAnswer={onAnswer} compact />
      <p className="mobileSwipeHint">Javob tanlang — telefonda keyingi savolga avtomatik o‘tadi.</p>
    </div>
  );
}


function MobileWritingSwiper({ tasks, answers, onAnswer, activeIndex, setActiveIndex, onSubmit, loading = false }) {
  const safeIndex = Math.min(activeIndex, Math.max(0, tasks.length - 1));
  const current = tasks[safeIndex];
  if (!current) return <div className="empty">Yozma topshiriqlar topilmadi</div>;

  const currentAnswer = answers[current.id] || '';
  const canGoNext = isWritingAnswerComplete(current, currentAnswer);
  const answeredCount = countCompletedWritingAnswers(tasks, answers);
  const allAnswered = answeredCount >= tasks.length;
  const hasNonFillTasks = tasks.some(task => task?.type !== 'fill_blank');

  function goNext() {
    if (safeIndex < tasks.length - 1) {
      setActiveIndex(safeIndex + 1);
    } else if (onSubmit) {
      onSubmit();
    }
  }

  return (
    <div className="mobileWritingSwiper">
      <div className="mobileSwiperTop">
        <button type="button" className="small" onClick={() => setActiveIndex(Math.max(0, safeIndex - 1))} disabled={safeIndex === 0}>← Oldingi</button>
        <strong>Yozma {safeIndex + 1}/{tasks.length}</strong>
        <button type="button" className="small" onClick={() => setActiveIndex(Math.min(tasks.length - 1, safeIndex + 1))} disabled={safeIndex === tasks.length - 1}>Keyingi →</button>
      </div>

      <div className="mobileDots" aria-label="Yozma mashqlar holati">
        {tasks.map((task, i) => (
          <button
            type="button"
            key={task.id}
            className={`${i === safeIndex ? 'active' : ''} ${String(answers[task.id] || '').trim() ? 'done' : ''}`}
            onClick={() => setActiveIndex(i)}
            aria-label={`${i + 1}-yozma mashq`}
          >
            {i + 1}
          </button>
        ))}
      </div>

      <div className="writingTask mobileWritingSlide" key={current.id}>
        <div className="writingTaskTop">
          <span>{safeIndex + 1}</span>
          <div>
            <h3>{current.title}</h3>
            {shouldShowWritingTaskHint(current) && <p>{current.hint}</p>}
          </div>
        </div>
        <WritingTaskAnswerArea
          task={current}
          value={currentAnswer}
          onChange={value => onAnswer(current.id, value)}
          autoFocus
        />
      </div>

      <div className="mobileWritingActions">
        <button
          type="button"
          className="primary big"
          onClick={goNext}
          disabled={loading || (!canGoNext && safeIndex < tasks.length - 1) || (safeIndex === tasks.length - 1 && !allAnswered)}
        >
          {safeIndex < tasks.length - 1 ? 'Keyingi yozma mashq →' : loading ? 'Tekshirilmoqda...' : 'Mashqni yakunlash'}
        </button>
        {hasNonFillTasks && <p className="mobileSwipeHint">Telefon versiyada yozma mashqlar ham bitta-bittadan chiqadi. Javobni yozing va keyingisiga o‘ting.</p>}
      </div>
    </div>
  );
}

function Landing({ onLogin, authMessage = '' }) {
  const [mode, setMode] = useState('home');
  const [subjects, setSubjects] = useState([]);

  useEffect(() => {
    api('/api/public/meta').then(data => setSubjects(data.subjects)).catch(() => setSubjects([
      { id: 'english', title: 'Ingliz tili', short: 'EN' },
      { id: 'russia', title: 'Rus tili', short: 'RU' },
      { id: 'koreys', title: 'Koreys tili', short: 'KO' },
      { id: 'ona_tili', title: 'Ona tili', short: 'OT' },
      { id: 'tarix', title: 'Tarix', short: 'TX' }
    ]));
  }, []);

  return (
    <main className="landingWrap">
      <section className="presentationHero singlePhoneHero">
        <div className="presentationLeft">
          <div className="logoLine">
            <div className="logoBubble">🌐</div>
            <div>
              <b>ENGLISH Mock</b>
              <span>LANGUAGE PLATFORM</span>
            </div>
          </div>

          <h1>
            <span>ENGLISH Mock</span>
            <strong>LANGUAGE PLATFORM</strong>
          </h1>
          <div className="titleUnderline" />
          <h2>Platformaning asosiy imkoniyatlari</h2>
          <p>
            Zamonaviy, bosqichma-bosqich va nazorat qilinadigan fan o‘rganish tizimi.
            Endi asosiy ekran o‘ng tomonda bitta katta telefon ichida ko‘rinadi.
          </p>

          <div className="presentationFeatures simpleFeatures">
            <FeatureMini icon="🔐" title="Login telefon ichida" />
            <FeatureMini icon="📝" title="Kursga yozilish telefon ichida" />
            <FeatureMini icon="📚" title="Bosqichma-bosqich dars" />
            <FeatureMini icon="🎤" title="Optional speaking mashqi" />
            <FeatureMini icon="🧪" title="Ketma-ket mavzu mashqi" />
            <FeatureMini icon="🏅" title="Sertifikat" />
          </div>
        </div>

        <div className="presentationRight singlePhoneRight">
          <div className="phoneMockup heroPhoneLarge">
            <div className="phoneTop">
              <span>9:41</span>
              <div className="phoneIsland" />
              <div className="phoneDots">● ● ●</div>
            </div>
            <div className="phoneAppArea">
              {mode === 'home' && <PhoneWelcome onLogin={() => setMode('login')} onEnroll={() => setMode('enroll')} />}
              {mode === 'login' && <PhoneLogin onBack={() => setMode('home')} onLogin={onLogin} />}
              {mode === 'enroll' && <PhoneEnroll subjects={subjects} onBack={() => setMode('home')} />}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function PhoneWelcome({ onLogin, onEnroll }) {
  return (
    <div className="phoneScreen phoneWelcome">
      <div className="phoneBrandBlock">
        <div className="phoneBrandIcon">🌐</div>
        <div>
          <b>ENGLISH Mock</b>
          <span>ENGLISH Mock</span>
        </div>
      </div>
      <div className="phoneHeroText">
        <h3>Xush kelibsiz!</h3>
        <p>Til o‘rganishni telefon uslubidagi qulay interfeys orqali boshlang.</p>
      </div>
      <div className="phoneMiniStats">
        <div><b>5</b><span>fan</span></div>
        <div><b>4</b><span>daraja</span></div>
        <div><b>15</b><span>mavzu</span></div>
      </div>
      <div className="phoneList">
        <div>✅ Login va kursga yozilish</div>
        <div>✅ Dars + misollar + vocabulary</div>
        <div>✅ 5 ta mavzu testi va progress</div>
        <div>✅ Speaking ixtiyoriy</div>
      </div>
      <div className="phoneBottomActions">
        <button className="primary" onClick={onLogin}>🔐 Login</button>
        <button className="ghost" onClick={onEnroll}>Kursga yozilish</button>
      </div>
    </div>
  );
}

function PhoneLogin({ onLogin, onBack }) {
  const [username, setUsername] = useState('student');
  const [password, setPassword] = useState('student123');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      localStorage.setItem('token', data.token);
      localStorage.setItem('alaziz_app_version', APP_VERSION);
      onLogin(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="phoneScreen phoneForm" onSubmit={submit}>
      <button type="button" className="backLink" onClick={onBack}>← Orqaga</button>
      <div className="phoneHeroText compact">
        <h3>Login</h3>
        <p>Admin bergan login va parol bilan kiring.</p>
      </div>
      <label>Login</label>
      <input value={username} onChange={e => setUsername(e.target.value)} placeholder="login" />
      <label>Parol</label>
      <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="parol" />
      {error && <div className="alert danger">{error}</div>}
      <button className="primary" disabled={loading}>{loading ? 'Tekshirilmoqda...' : '🚀 Kirish'}</button>
    </form>
  );
}

function PhoneEnroll({ subjects, onBack }) {
  const [form, setForm] = useState({
    fullName: '', year: '2010', month: '01', day: '01', language: 'english', phone: '+998', telegram: '@'
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const years = Array.from({ length: 50 }, (_, i) => String(new Date().getFullYear() - 5 - i));
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
  const days = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'));

  async function submit(e) {
    e.preventDefault();
    setMessage('');
    setError('');
    setLoading(true);
    try {
      const body = {
        fullName: form.fullName.trim(),
        birthDate: `${form.year}-${form.month}-${form.day}`,
        language: form.language,
        phone: form.phone.trim(),
        telegram: form.telegram.trim()
      };
      const data = await api('/api/enroll', { method: 'POST', body: JSON.stringify(body) });
      setMessage(data.message);
      setForm({ fullName: '', year: '2010', month: '01', day: '01', language: 'english', phone: '+998', telegram: '@' });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="phoneScreen phoneForm phoneEnrollForm" onSubmit={submit}>
      <button type="button" className="backLink" onClick={onBack}>← Orqaga</button>
      <div className="phoneHeroText compact">
        <h3>Kursga yozilish</h3>
        <p>Ariza admin panelga yuboriladi.</p>
      </div>
      <label>Ism familya</label>
      <input value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} placeholder="Ali Valiyev" />
      <label>Tug‘ilgan sana</label>
      <div className="dateGrid">
        <select value={form.year} onChange={e => setForm({ ...form, year: e.target.value })}>{years.map(y => <option key={y}>{y}</option>)}</select>
        <select value={form.month} onChange={e => setForm({ ...form, month: e.target.value })}>{months.map(m => <option key={m}>{m}</option>)}</select>
        <select value={form.day} onChange={e => setForm({ ...form, day: e.target.value })}>{days.map(d => <option key={d}>{d}</option>)}</select>
      </div>
      <label>Til tanlang</label>
      <select value={form.language} onChange={e => setForm({ ...form, language: e.target.value })}>
        {subjects.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
      </select>
      <label>Telefon raqam</label>
      <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+998 90 123 45 67" />
      <label>Telegram username</label>
      <input value={form.telegram} onChange={e => setForm({ ...form, telegram: e.target.value })} placeholder="@username" />
      {message && <div className="alert success">{message}</div>}
      {error && <div className="alert danger">{error}</div>}
      <button className="primary" disabled={loading}>{loading ? 'Yuborilmoqda...' : '📨 Yuborish'}</button>
    </form>
  );
}

function FeatureMini({ icon, title }) {
  return (
    <div className="featureMini">
      <div className="featureIcon">{icon}</div>
      <b>{title}</b>
    </div>
  );
}

function PhoneHome({ onLogin, onEnroll }) {
  return (
    <div className="phoneHome">
      <div className="phoneBrand">
        <div className="phoneLogo">EM</div>
        <div>
          <b>ENGLISH Mock</b>
          <span>LANGUAGE PLATFORM</span>
        </div>
      </div>
      <h2>Xush kelibsiz!</h2>
      <p>Login qiling yoki kursga yozilish formasini telefon ekranining ichida to‘ldiring.</p>
      <div className="phoneHomeActions">
        <button className="primary" onClick={onLogin}>Login / Parol kiritish</button>
        <button className="greenBtn" onClick={onEnroll}>Kursga yozilish</button>
      </div>
      <div className="phonePreviewCard">
        <div className="appTopRow">
          <span>🔥 12</span>
          <span>💎 350</span>
          <span className="avatarMini">U</span>
        </div>
        <div className="lessonDayCard">
          <div>
            <b>Bugungi dars</b>
            <small>Kundalik maqsad</small>
          </div>
          <button>Tahrirlash</button>
        </div>
        <div className="progressCourseCard">
          <div className="circleStat">3/5</div>
          <div>
            <b>Darslarni yakunlang</b>
            <small>15 XP</small>
            <div className="miniProgress"><span style={{ width: '68%' }} /></div>
          </div>
        </div>
      </div>
      <div className="phoneHint">Ichkariga kirgandan keyin darslar ham telefon app ko‘rinishida ochiladi.</div>
    </div>
  );
}

function WelcomeCard({ onLogin, onEnroll }) {
  return (
    <div className="welcomeCard">
      <div className="mascot">🦉</div>
      <h2>Platformaga xush kelibsiz</h2>
      <p>Avval kursga yoziling. Ma’lumotlaringiz adminga tushadi. Admin sizga login, parol, fan, active/non-active va account tugash vaqtini belgilaydi.</p>
      <div className="steps">
        <span>1. Kursga yozilish</span>
        <span>2. Admin tasdiqlaydi</span>
        <span>3. Login orqali kirish</span>
        <span>4. Beginner dan boshlash</span>
      </div>
      <div className="actions center">
        <button className="primary" onClick={onLogin}>Login qilish</button>
        <button className="ghost" onClick={onEnroll}>Kursga yozilish</button>
      </div>
    </div>
  );
}

function LoginForm({ onLogin, onBack }) {
  const [username, setUsername] = useState('student');
  const [password, setPassword] = useState('student123');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      localStorage.setItem('token', data.token);
      localStorage.setItem('alaziz_app_version', APP_VERSION);
      onLogin(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="authCard" onSubmit={submit}>
      <button type="button" className="backLink" onClick={onBack}>← Orqaga</button>
      <h2>Login</h2>
      <p>Admin bergan login va parol bilan kiring.</p>
      <label>Login</label>
      <input value={username} onChange={e => setUsername(e.target.value)} placeholder="login" />
      <label>Parol</label>
      <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="parol" />
      {error && <div className="alert danger">{error}</div>}
      <button className="primary" disabled={loading}>{loading ? 'Tekshirilmoqda...' : '🚀 Kirish'}</button>
      <div className="demoBox">
        <b>Demo:</b>
        <span>Admin: admin / admin123</span>
        <span>English: student / student123</span>
        <span>Rus: russtudent / student123</span>
        <span>Koreys: korstudent / student123</span>
      </div>
    </form>
  );
}

function EnrollForm({ subjects, onBack }) {
  const [form, setForm] = useState({
    fullName: '', year: '2010', month: '01', day: '01', language: 'english', phone: '+998', telegram: '@'
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const years = Array.from({ length: 50 }, (_, i) => String(new Date().getFullYear() - 5 - i));
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
  const days = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'));

  async function submit(e) {
    e.preventDefault();
    setMessage('');
    setError('');
    setLoading(true);
    try {
      const body = {
        fullName: form.fullName.trim(),
        birthDate: `${form.year}-${form.month}-${form.day}`,
        language: form.language,
        phone: form.phone.trim(),
        telegram: form.telegram.trim()
      };
      const data = await api('/api/enroll', { method: 'POST', body: JSON.stringify(body) });
      setMessage(data.message);
      setForm({ fullName: '', year: '2010', month: '01', day: '01', language: 'english', phone: '+998', telegram: '@' });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="authCard" onSubmit={submit}>
      <button type="button" className="backLink" onClick={onBack}>← Orqaga</button>
      <h2>Kursga yozilish</h2>
      <p>Ma’lumotlaringizni kiriting. Bu ariza admin panelga kelib tushadi.</p>
      <label>Ism familya</label>
      <input value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} placeholder="Ali Valiyev" />
      <label>Tug‘ilgan sana</label>
      <div className="dateGrid">
        <select value={form.year} onChange={e => setForm({ ...form, year: e.target.value })}>{years.map(y => <option key={y}>{y}</option>)}</select>
        <select value={form.month} onChange={e => setForm({ ...form, month: e.target.value })}>{months.map(m => <option key={m}>{m}</option>)}</select>
        <select value={form.day} onChange={e => setForm({ ...form, day: e.target.value })}>{days.map(d => <option key={d}>{d}</option>)}</select>
      </div>
      <label>Til tanlang</label>
      <select value={form.language} onChange={e => setForm({ ...form, language: e.target.value })}>
        {subjects.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
      </select>
      <label>Telefon raqam</label>
      <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+998 90 123 45 67" />
      <label>Telegram username</label>
      <input value={form.telegram} onChange={e => setForm({ ...form, telegram: e.target.value })} placeholder="@username" />
      {message && <div className="alert success">{message}</div>}
      {error && <div className="alert danger">{error}</div>}
      <button className="primary" disabled={loading}>{loading ? 'Yuborilmoqda...' : '📨 Yuborish'}</button>
    </form>
  );
}

function Header({ user, onLogout }) {
  return (
    <header className="topbar">
      <div className="topBrand"><div className="smallLogo">EM</div><div><b>ENGLISH Mock</b><span>ENGLISH Mock</span></div></div>
      <div className="userBox">
        <span>{user.fullName} · {user.subjectTitle}</span>
        <button onClick={() => safeLogout(onLogout)}>Chiqish</button>
      </div>
    </header>
  );
}

function AdminPanel({ onLogout }) {
  const [meta, setMeta] = useState(null);
  const [users, setUsers] = useState([]);
  const [enrollments, setEnrollments] = useState([]);
  const [certificates, setCertificates] = useState([]);
  const [reportRows, setReportRows] = useState([]);
  const [report, setReport] = useState(null);
  const [usersPage, setUsersPage] = useState(1);
  const [usersTotal, setUsersTotal] = useState(0);
  const [usersTotalPages, setUsersTotalPages] = useState(1);
  const [certPage, setCertPage] = useState(1);
  const [certTotal, setCertTotal] = useState(0);
  const [certTotalPages, setCertTotalPages] = useState(1);
  const [backups, setBackups] = useState([]);
  const [actionLogs, setActionLogs] = useState([]);
  const [systemLogs, setSystemLogs] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [centers, setCenters] = useState([]);
  const [selectedCenterId, setSelectedCenterId] = useState('center_main');
  const [centerUsers, setCenterUsers] = useState([]);
  const [centerForm, setCenterForm] = useState({ name: '', logoDataUrl: '', adminUsername: '', adminPassword: '', adminFullName: '' });
  const [teacherDashboard, setTeacherDashboard] = useState(null);
  const [topicEditor, setTopicEditor] = useState({ language: 'english', level: 'Beginner', topicNo: 1, youtubeVideoUrl: '', extraNote: '', vocabularyText: '', questionsText: '' });
  const [importText, setImportText] = useState('');
  const [selectedUser, setSelectedUser] = useState(null);
  const [query, setQuery] = useState('');
  const [accountQuery, setAccountQuery] = useState('');
  const [accountStatusFilter, setAccountStatusFilter] = useState('all');
  const [selectedAccountIds, setSelectedAccountIds] = useState([]);
  const [progressUsers, setProgressUsers] = useState([]);
  const [progressQuery, setProgressQuery] = useState('');
  const [progressStatusFilter, setProgressStatusFilter] = useState('all');
  const [progressSubjectFilter, setProgressSubjectFilter] = useState('all');
  const [progressLoading, setProgressLoading] = useState(false);
  const [certQuery, setCertQuery] = useState('');
  const [certSubject, setCertSubject] = useState('all');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [activeCreateRole, setActiveCreateRole] = useState(null);
  const [adminTab, setAdminTab] = useState(() => readAdminRouteFromHash() || 'dashboard');
  const [adminMobileMenuOpen, setAdminMobileMenuOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ role: 'student', username: '', password: '', fullName: '', birthDate: '', subject: 'english', isActive: true, expiresAt: todayPlus(90), paymentStatus: 'paid', paymentAmount: '', paymentNote: '', allowUnlimitedTopics: false, topicAccessMode: 'daily', centerId: 'center_main' });
  const planDayOptions = ['Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba', 'Yakshanba'];
  const [planUsers, setPlanUsers] = useState([]);
  const [planQuery, setPlanQuery] = useState('');
  const [selectedPlanUsers, setSelectedPlanUsers] = useState([]);
  const [selectedPlanDays, setSelectedPlanDays] = useState([]);
  const [selectedPlanLevels, setSelectedPlanLevels] = useState([]);
  const [selectedTopicAccessMode, setSelectedTopicAccessMode] = useState('');
  const [plansLoading, setPlansLoading] = useState(false);


  useEffect(() => {
    const onHashChange = () => {
      const nextTab = readAdminRouteFromHash();
      if (nextTab) setAdminTab(nextTab);
    };
    onHashChange();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    writeAdminRouteToHash(adminTab);
    setAdminMobileMenuOpen(false);
  }, [adminTab]);

  const subjectOptions = meta?.subjects || [];
  const allLevels = meta?.levels || ['Beginner', 'Elementary', 'Pre-Intermediate', 'Intermediate'];
  const canAll = meta?.currentAdmin?.subject === 'all';
  const isSuperAdmin = !!meta?.currentAdmin?.isSuper;
  const visibleCenters = centers.length ? centers : (meta?.centers || []);

  async function loadBase() {
    const [m, e, r, b, logs, sys, notes] = await Promise.all([
      api('/api/admin/meta'),
      api('/api/admin/enrollments?page=1&pageSize=9'),
      api('/api/admin/report'),
      api('/api/admin/backups'),
      api('/api/admin/action-logs?page=1&pageSize=12'),
      api('/api/admin/system-logs?page=1&pageSize=8'),
      api('/api/admin/notifications')
    ]);
    setMeta(m);
    setEnrollments(e.enrollments || []);
    setReport(r || null);
    setReportRows(r.lowTopicRows || r.rows || []);
    setBackups(b.backups || []);
    setActionLogs(logs.logs || []);
    setSystemLogs(sys.logs || []);
    setNotifications(notes.notifications || r.notifications || []);
    setCenters(m.centers || []);
    if (m.currentAdmin?.isSuper) {
      try {
        const centerData = await api('/api/admin/centers');
        setCenters(centerData.centers || []);
        setSelectedCenterId(centerData.selectedCenter?.id || centerData.centers?.[0]?.id || 'center_main');
        setCenterUsers(centerData.users || []);
      } catch (centerErr) {
        console.warn(centerErr);
      }
    }
    if (!m.subjects.find(s => s.id === form.subject) && form.subject !== 'all') {
      setForm(prev => ({ ...prev, subject: m.subjects[0]?.id || 'english' }));
    }
  }

  async function loadUsers(page = usersPage) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: '8',
      search: accountQuery.trim(),
      status: accountStatusFilter
    });
    const data = await api(`/api/admin/users?${params.toString()}`);
    setUsers(data.users || []);
    setUsersPage(data.page || page);
    setUsersTotal(data.total || 0);
    setUsersTotalPages(data.totalPages || 1);
  }


  async function loadCenters(centerId = selectedCenterId) {
    if (!isSuperAdmin && !meta?.currentAdmin?.isSuper) return null;
    const params = new URLSearchParams();
    if (centerId) params.set('selected', centerId);
    const data = await api(`/api/admin/centers?${params.toString()}`);
    setCenters(data.centers || []);
    setSelectedCenterId(data.selectedCenter?.id || data.centers?.[0]?.id || 'center_main');
    setCenterUsers(data.users || []);
    return data;
  }

  async function createCenter(e) {
    e.preventDefault();
    setMessage('');
    try {
      const data = await api('/api/admin/centers', { method: 'POST', body: JSON.stringify(centerForm) });
      setMessage(data.message || 'Markaz yaratildi');
      setCenterForm({ name: '', logoDataUrl: '', adminUsername: '', adminPassword: '', adminFullName: '' });
      await loadCenters(data.center?.id);
      await reloadAll();
      setAdminTab('centers');
    } catch (err) {
      setMessage(err.message);
    }
  }

  function handleCenterLogoFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 320000) {
      setMessage('Logo hajmi 300 KB dan kichik bo‘lsin');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setCenterForm(prev => ({ ...prev, logoDataUrl: String(reader.result || '') }));
    reader.readAsDataURL(file);
  }

  async function loadPlanUsers() {
    setPlansLoading(true);
    try {
      const params = new URLSearchParams({
        page: '1',
        pageSize: '500',
        role: 'student',
        search: planQuery.trim(),
        status: 'all'
      });
      const data = await api(`/api/admin/users?${params.toString()}`);
      const list = data.users || [];
      setPlanUsers(list);
      setSelectedPlanUsers(prev => prev.filter(id => list.some(user => user.id === id)));
    } finally {
      setPlansLoading(false);
    }
  }

  function togglePlanUser(userId) {
    setSelectedPlanUsers(prev => prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]);
  }

  function toggleAllPlanUsers() {
    const ids = planUsers.map(user => user.id);
    setSelectedPlanUsers(prev => prev.length === ids.length ? [] : ids);
  }

  function togglePlanDay(day) {
    setSelectedPlanDays(prev => prev.includes(day) ? prev.filter(item => item !== day) : [...prev, day]);
  }

  function togglePlanLevel(levelName) {
    setSelectedPlanLevels(prev => prev.includes(levelName) ? prev.filter(item => item !== levelName) : [...prev, levelName]);
  }

  async function assignPlanDays() {
    if (!selectedPlanUsers.length) {
      setMessage('Avval o‘quvchilarni belgilang');
      return;
    }
    if (!selectedPlanDays.length && !selectedPlanLevels.length && !selectedTopicAccessMode) {
      setMessage('Kamida bitta kun, ochiladigan daraja yoki mavzu rejimini tanlang');
      return;
    }
    const data = await api('/api/admin/users/plan-days/bulk', {
      method: 'PATCH',
      body: JSON.stringify({ userIds: selectedPlanUsers, planDays: selectedPlanDays, unlockedLevels: selectedPlanLevels, topicAccessMode: selectedTopicAccessMode, allowUnlimitedTopics: selectedTopicAccessMode === 'unlimited' })
    });
    setMessage(data.message || 'Kunlar yoki darajalar biriktirildi');
    setSelectedPlanUsers([]);
    setSelectedTopicAccessMode('');
    await loadPlanUsers();
  }

  async function loadProgressUsers() {
    setProgressLoading(true);
    try {
      const params = new URLSearchParams({
        page: '1',
        pageSize: '500',
        role: 'student',
        search: progressQuery.trim(),
        status: progressStatusFilter,
        subject: progressSubjectFilter
      });
      const data = await api(`/api/admin/users?${params.toString()}`);
      setProgressUsers(data.users || []);
    } finally {
      setProgressLoading(false);
    }
  }

  async function loadCertificates(page = certPage) {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: '8',
      search: certQuery.trim(),
      subject: certSubject
    });
    const data = await api(`/api/admin/certificates?${params.toString()}`);
    setCertificates(data.certificates || []);
    setCertPage(data.page || page);
    setCertTotal(data.total || 0);
    setCertTotalPages(data.totalPages || 1);
  }

  async function reloadAll() {
    await Promise.all([loadBase(), loadUsers(usersPage), loadProgressUsers(), loadPlanUsers(), loadCertificates(certPage)]);
    if (isSuperAdmin || meta?.currentAdmin?.isSuper) await loadCenters(selectedCenterId).catch(() => null);
  }

  useEffect(() => { loadBase().catch(err => setMessage(err.message)); }, []);
  useEffect(() => { loadUsers(usersPage).catch(err => setMessage(err.message)); }, [usersPage, accountQuery, accountStatusFilter]);
  useEffect(() => { if (adminTab === 'progress') loadProgressUsers().catch(err => setMessage(err.message)); }, [adminTab, progressQuery, progressStatusFilter, progressSubjectFilter]);
  useEffect(() => { if (adminTab === 'plans') loadPlanUsers().catch(err => setMessage(err.message)); }, [adminTab, planQuery]);
  useEffect(() => { loadCertificates(certPage).catch(err => setMessage(err.message)); }, [certPage, certQuery, certSubject]);
  useEffect(() => { setUsersPage(1); }, [accountQuery, accountStatusFilter]);
  useEffect(() => { setCertPage(1); }, [certQuery, certSubject]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 2000);
    return () => window.clearTimeout(timer);
  }, [message]);


  function defaultSubjectForRole(role) {
    if (role === 'admin' && canAll) return 'all';
    return subjectOptions[0]?.id || meta?.subjects?.[0]?.id || 'english';
  }

  function openCreatePanel(role) {
    const nextSubject = role === 'student' && form.subject === 'all' ? defaultSubjectForRole(role) : (role === 'admin' && canAll ? 'all' : form.subject || defaultSubjectForRole(role));
    setActiveCreateRole(role);
    setForm(prev => ({ ...prev, role, subject: nextSubject }));
    setMessage('');
  }

  async function createUser(e) {
    e.preventDefault();
    setMessage('');
    try {
      const roleAfterCreate = activeCreateRole || form.role;
      const data = await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ ...form, role: roleAfterCreate }) });
      setMessage(data.message || 'Foydalanuvchi yaratildi');
      setForm({ role: roleAfterCreate, username: '', password: '', fullName: '', birthDate: '', subject: defaultSubjectForRole(roleAfterCreate), isActive: true, expiresAt: todayPlus(90), paymentStatus: 'paid', paymentAmount: '', paymentNote: '', allowUnlimitedTopics: false, topicAccessMode: 'daily', centerId: form.centerId || selectedCenterId || 'center_main' });
      await reloadAll();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function updateUser(user, patch) {
    setMessage('');
    try {
      const data = await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setMessage(data.message);
      await reloadAll();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function deleteUserAccount(user) {
    setMessage('');
    if (!isSuperAdmin) {
      setMessage('Faqat Pro Admin account o‘chira oladi');
      return;
    }
    if (user.id === meta?.currentAdmin?.id) {
      setMessage('O‘zingiz kirgan Pro Admin accountni o‘chira olmaysiz');
      return;
    }
    const ok = window.confirm(`${user.fullName || user.username} accountini rostdan ham o‘chirmoqchimisiz?

Bu amal qaytarib bo‘lmaydi.`);
    if (!ok) return;
    try {
      const data = await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      setMessage(data.message || 'Account o‘chirildi');
      if (selectedUserId === user.id) {
        setSelectedUserId('');
        setSelectedUser(null);
      }
      await reloadAll();
    } catch (err) {
      setMessage(err.message);
    }
  }


  function toggleAccountSelection(userId) {
    setSelectedAccountIds(prev => prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]);
  }

  function toggleAllVisibleAccounts() {
    setSelectedAccountIds(prev => {
      if (allVisibleAccountsSelected) return prev.filter(id => !selectableAccountIds.includes(id));
      return Array.from(new Set([...prev, ...selectableAccountIds]));
    });
  }

  async function deleteSelectedAccounts() {
    setMessage('');
    if (!isSuperAdmin) {
      setMessage('Faqat Pro Admin account o‘chira oladi');
      return;
    }
    const ids = selectedAccountIds.filter(id => id !== meta?.currentAdmin?.id);
    if (!ids.length) {
      setMessage('O‘chirish uchun account belgilang');
      return;
    }
    const ok = window.confirm(`${ids.length} ta accountni rostdan ham o‘chirmoqchimisiz?

Bu amal qaytarib bo‘lmaydi.`);
    if (!ok) return;
    try {
      const results = [];
      for (const id of ids) {
        const user = users.find(item => item.id === id);
        if (!user || user.id === meta?.currentAdmin?.id) continue;
        const data = await api(`/api/admin/users/${id}`, { method: 'DELETE' });
        results.push(data);
      }
      setSelectedAccountIds([]);
      setMessage(`${results.length} ta account o‘chirildi`);
      if (ids.includes(selectedUserId)) {
        setSelectedUserId('');
        setSelectedUser(null);
      }
      await reloadAll();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function toggleUserStatus(user) {
    const shouldActivate = user.status !== 'active';
    const patch = { isActive: shouldActivate };
    if (shouldActivate) {
      const expired = user.expiresAt && new Date(user.expiresAt + 'T23:59:59') < new Date();
      if (!user.expiresAt || expired) patch.expiresAt = todayPlus(90);
    }
    await updateUser(user, patch);
  }

  async function selectUserProgress(userId) {
    setMessage('');
    try {
      const data = await api(`/api/admin/users/${userId}/progress`);
      setSelectedUserId(userId);
      setSelectedUser(data.user);
      setAdminTab('progress');
      window.setTimeout(() => document.querySelector('.studentProgressDetailCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function updateEnrollment(item, status) {
    setMessage('');
    try {
      const data = await api(`/api/admin/enrollments/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setMessage(data.message);
      await reloadAll();
    } catch (err) {
      setMessage(err.message);
    }
  }


  async function createBackup() {
    setMessage('');
    try {
      const data = await api('/api/admin/backups', { method: 'POST', body: JSON.stringify({}) });
      setMessage(data.message || 'Backup yaratildi');
      const list = await api('/api/admin/backups');
      setBackups(list.backups || []);
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function importUsersCsv() {
    setMessage('');
    try {
      const data = await api('/api/admin/import/users-csv', { method: 'POST', body: JSON.stringify({ csv: importText }) });
      setMessage(data.message || 'Import tugadi');
      setImportText('');
      await reloadAll();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function saveTopicEditor(e) {
    e.preventDefault();
    setMessage('');
    try {
      const data = await api('/api/admin/topic-editor', { method: 'PUT', body: JSON.stringify(topicEditor) });
      setMessage(data.message || 'Mavzu kontenti saqlandi');
      await loadBase();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function loadTopicEditor() {
    setMessage('');
    try {
      const params = new URLSearchParams({ language: topicEditor.language, level: topicEditor.level, topicNo: String(topicEditor.topicNo) });
      const data = await api(`/api/admin/topic-editor?${params.toString()}`);
      const o = data.override || {};
      setTopicEditor(prev => ({
        ...prev,
        youtubeVideoUrl: o.youtubeVideo?.searchUrl || '',
        extraNote: o.extraNote || '',
        vocabularyText: (o.vocabulary || []).map(v => `${v.word}|${v.meaning || ''}|${v.example || ''}`).join('\n'),
        questionsText: (o.questions || []).map(q => `${q.question}|${(q.options || []).join('|')}|${q.correctIndex || 0}|${q.note || ''}`).join('\n')
      }));
    } catch (err) {
      setMessage(err.message);
    }
  }

  function fillFromEnrollment(item) {
    const loginBase = item.fullName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'student';
    setActiveCreateRole('student');
    setForm({
      role: 'student',
      username: `${loginBase}_${Math.floor(Math.random() * 900 + 100)}`,
      password: Math.random().toString(36).slice(2, 8),
      fullName: item.fullName,
      birthDate: item.birthDate,
      subject: item.language,
      isActive: true,
      expiresAt: todayPlus(90),
      paymentStatus: 'paid',
      paymentAmount: '',
      paymentNote: '',
      centerId: item.centerId || selectedCenterId || 'center_main'
    });
    setAdminTab('create');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const stats = report?.stats || {};
  const studentUsers = users.filter(user => user.role === 'student');
  const adminUsers = users.filter(user => user.role === 'admin');
  const activeCount = stats.activeCount ?? studentUsers.filter(user => user.status === 'active').length;
  const nonActiveCount = stats.nonActiveCount ?? studentUsers.filter(user => user.status !== 'active').length;
  const expiredCount = stats.expiredCount ?? studentUsers.filter(user => user.status === 'expired').length;
  const pendingEnrollments = stats.pendingEnrollments ?? enrollments.filter(item => item.status === 'new').length;
  const avgProgress = stats.avgProgress ?? Math.round(studentUsers.reduce((sum, user) => sum + Number(user.progressPercent || 0), 0) / Math.max(1, studentUsers.length));
  const avgSpeaking = stats.avgSpeaking ?? Math.round(studentUsers.reduce((sum, user) => sum + Number(user.speakingPercent || 0), 0) / Math.max(1, studentUsers.length));
  const totalAttempts = stats.totalAttempts ?? reportRows.reduce((sum, row) => sum + Number(row.attempts || 0), 0);
  const masteredTopics = stats.masteredTopics ?? reportRows.filter(row => row.topicNo && Number(row.bestScore || 0) >= TOPIC_PASS_SCORE).length;
  const lowTopicRows = report?.lowTopicRows || reportRows;
  const speakingRows = report?.speakingRows || [];
  const weakStudents = report?.weakStudents || [...studentUsers]
    .sort((a, b) => Number(a.progressPercent || 0) - Number(b.progressPercent || 0) || Number(a.currentTopicScore || 0) - Number(b.currentTopicScore || 0))
    .slice(0, 5);
  const expiringSoon = report?.expiringSoon || studentUsers.filter(user => {
    if (!user.expiresAt || user.status !== 'active') return false;
    const diff = Math.ceil((new Date(user.expiresAt + 'T23:59:59') - new Date()) / (1000 * 60 * 60 * 24));
    return diff >= 0 && diff <= 7;
  });
  const subjectStats = report?.subjectStats || subjectOptions.map(subject => {
    const subjectStudents = studentUsers.filter(user => user.subject === subject.id);
    const active = subjectStudents.filter(user => user.status === 'active').length;
    const avg = Math.round(subjectStudents.reduce((sum, user) => sum + Number(user.progressPercent || 0), 0) / Math.max(1, subjectStudents.length));
    const completed = reportRows.filter(row => row.subject === subject.id && row.topicNo && Number(row.bestScore || 0) >= TOPIC_PASS_SCORE).length;
    return { ...subject, count: subjectStudents.length, active, avg, completed };
  });
  const levelStats = report?.levelStats || allLevels.map(level => {
    const levelUsers = studentUsers.filter(user => (user.currentLevel || 'Beginner') === level);
    const avg = Math.round(levelUsers.reduce((sum, user) => sum + Number(user.progressPercent || 0), 0) / Math.max(1, levelUsers.length));
    return { level, count: levelUsers.length, avg };
  });
  const unpaidCount = stats.unpaidCount ?? studentUsers.filter(user => user.paymentStatus === 'unpaid').length;
  const paidCount = Math.max(0, (stats.studentCount ?? studentUsers.length) - unpaidCount);
  const studentTotalForRate = Math.max(1, stats.studentCount ?? studentUsers.length);
  const activePercent = Math.round((activeCount / studentTotalForRate) * 100);
  const focusCount = pendingEnrollments + unpaidCount + expiringSoon.length + weakStudents.length;
  const centerStatsList = report?.centerStats || visibleCenters || [];
  const selectedCenter = centerStatsList.find(center => center.id === selectedCenterId) || centerStatsList[0] || null;
  const selectedCenterUsers = centerUsers.length ? centerUsers : users.filter(user => !selectedCenter || user.centerId === selectedCenter.id);

  const filteredEnrollments = enrollments.filter(item => `${item.fullName} ${item.phone} ${item.telegram} ${item.languageTitle} ${item.status}`.toLowerCase().includes(query.toLowerCase()));
  const filteredUsers = users;
  const selectableAccountIds = filteredUsers.filter(user => user.id !== meta?.currentAdmin?.id).map(user => user.id);
  const selectedAccountsCount = selectedAccountIds.length;
  const allVisibleAccountsSelected = selectableAccountIds.length > 0 && selectableAccountIds.every(id => selectedAccountIds.includes(id));
  const selectedUserData = selectedUser || progressUsers.find(user => user.id === selectedUserId) || users.find(user => user.id === selectedUserId) || null;
  const selectedTopicGroups = selectedUserData?.topicProgress || [];
  const filteredCertificates = certificates;
  const adminMenu = [
    { group: 'Asosiy', id: 'dashboard', icon: '🏠', title: 'Dashboard', desc: 'Umumiy holat', badge: focusCount ? String(focusCount) : '' },
    isSuperAdmin && { group: 'Boshqaruv', id: 'centers', icon: '🏢', title: 'Markazlar', desc: `${centerStatsList.length || 0} markaz`, badge: centerStatsList.length ? String(centerStatsList.length) : '' },
    { group: 'Boshqaruv', id: 'create', icon: '➕', title: 'Yaratish', desc: 'Yangi account' },
    { group: 'Boshqaruv', id: 'accounts', icon: '👥', title: 'Accountlar', desc: `${usersTotal} foydalanuvchi`, badge: usersTotal ? String(usersTotal) : '' },
    { group: 'Boshqaruv', id: 'plans', icon: '📅', title: 'Rejalar', desc: `${planUsers.length || stats.studentCount || 0} o‘quvchi` },
    { group: 'Boshqaruv', id: 'enrollments', icon: '📨', title: 'Arizalar', desc: `${pendingEnrollments} yangi`, badge: pendingEnrollments ? String(pendingEnrollments) : '' },
    { group: 'Monitoring', id: 'progress', icon: '📊', title: 'Progress', desc: `${progressUsers.length || stats.studentCount || 0} o‘quvchi` },
    { group: 'Monitoring', id: 'certificates', icon: '🏅', title: 'Sertifikatlar', desc: `${certTotal} ta`, badge: certTotal ? String(certTotal) : '' },
    { group: 'Monitoring', id: 'shopOrders', icon: '🛒', title: 'Magazine', desc: 'Buyurtmalar' },
  ].filter(Boolean);
  const adminMenuGroups = ['Asosiy', 'Boshqaruv', 'Monitoring']
    .map(group => ({ group, items: adminMenu.filter(item => item.group === group) }))
    .filter(section => section.items.length);
  const adminDisplayName = meta?.currentAdmin?.fullName || 'ENGLISH Mock';
  const adminInitials = adminDisplayName
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'AA';
  const adminBrand = panelBrand(meta?.currentAdmin, {
    subtitle: 'Markaz paneli',
    superName: 'ENGLISH Mock HQ',
    superSubtitle: 'Multi-center control'
  });


  return (
    <main className={`page adminPage adminShellPage adminModernPage ${adminMobileMenuOpen ? 'adminMobileMenuOpen' : ''}`}> 
      <section className="adminModernTop">
        <button type="button" className="adminMobileMenuToggle" aria-label="Admin menyuni ochish" onClick={() => setAdminMobileMenuOpen(true)}>☰</button>
        <div className="adminModernTitle">
          <h1><span className="desktopAdminTitle">Admin boshqaruv paneli</span><span className="mobileAdminTitle">Pro Admin</span></h1>
          <p>Boshqaruv va nazorat markazi</p>
        </div>
        <div className="adminTopTools adminTopToolsCompact">
          <button type="button" className="adminProfileChip adminProfileChipCompact" onClick={() => safeLogout(onLogout)} title="Chiqish">
            <strong>{adminInitials}</strong>
            <div>
              <b>{adminDisplayName}</b>
              <span>{isSuperAdmin ? 'Katta admin' : (meta?.currentAdmin?.centerName || 'Markaz admin')}</span>
            </div>
            <em>⌄</em>
          </button>
        </div>
      </section>

      <section className="adminKpiGrid">
        <button type="button" className="adminKpiCard" onClick={() => setAdminTab('enrollments')}><span>Yangi arizalar</span><b>{pendingEnrollments}</b><small>Ko‘rib chiqish</small></button>
        <button type="button" className="adminKpiCard" onClick={() => { setAccountStatusFilter('all'); setAdminTab('accounts'); }}><span>O‘quvchilar</span><b>{stats.studentCount ?? usersTotal}</b><small>Jami</small></button>
        <button type="button" className="adminKpiCard" onClick={() => setAdminTab('certificates')}><span>Sertifikatlar</span><b>{stats.certificateCount || certTotal}</b><small>Berilgan</small></button>
        <button type="button" className="adminKpiCard revenue" onClick={() => setAdminTab('accounts')}><span>To‘lovlar</span><b>{paidCount}</b><small>To‘langan</small></button>
      </section>

      {adminTab === 'dashboard' && (
        <section className="proAdminMobileMock">
          <div className="mobileAdminSection">
            <h2>Asosiy boshqaruv</h2>
            <button type="button" onClick={() => setAdminTab('accounts')}><i>👤</i><span><b>O‘quvchilar</b><small>O‘quvchilarni boshqarish</small></span><em>›</em></button>
            <button type="button" onClick={() => setAdminTab('enrollments')}><i>📄</i><span><b>Arizalar</b><small>Yangi arizalarni ko‘rish</small></span><em>›</em></button>
            <button type="button" onClick={() => setAdminTab('certificates')}><i>🏅</i><span><b>Sertifikatlar</b><small>Sertifikatlarni boshqarish</small></span><em>›</em></button>
            <button type="button" onClick={() => setAdminTab('plans')}><i>📘</i><span><b>Kurslar</b><small>Kurslar va darslarni boshqarish</small></span><em>›</em></button>
            <button type="button" onClick={() => setAdminTab('progress')}><i>💬</i><span><b>Progress</b><small>Natijalarni ko‘rish</small></span><em>›</em></button>
          </div>

          <div className="mobileAdminSection mobileStatsCard">
            <div className="mobileSectionHead"><h2>Statistika</h2><span>Bu oy⌄</span></div>
            <div className="fakeChart"><svg viewBox="0 0 320 120" preserveAspectRatio="none"><path d="M10 88 C55 62 75 58 105 78 C138 100 150 47 190 48 C228 50 244 75 276 54 C294 43 307 50 315 58" fill="none" stroke="#2563eb" strokeWidth="5" strokeLinecap="round"/><path d="M10 88 C55 62 75 58 105 78 C138 100 150 47 190 48 C228 50 244 75 276 54 C294 43 307 50 315 58 L315 118 L10 118 Z" fill="rgba(37,99,235,.10)"/></svg></div>
          </div>

          <div className="mobileAdminSection">
            <div className="mobileSectionHead"><h2>So‘nggi faoliyatlar</h2><button type="button" onClick={() => setAdminTab('accounts')}>Barchasi</button></div>
            <div className="mobileActivity"><i>✅</i><span><b>Yangi o‘quvchi ro‘yxatdan o‘tdi</b><small>{studentUsers[0]?.fullName || 'O‘quvchi'}</small></span><em>Bugun</em></div>
            <div className="mobileActivity"><i>📄</i><span><b>Yangi ariza kelib tushdi</b><small>{enrollments[0]?.fullName || 'Ariza'}</small></span><em>Bugun</em></div>
          </div>
        </section>
      )}

      <button type="button" className="adminMobileBackdrop" aria-label="Admin menyuni yopish" onClick={() => setAdminMobileMenuOpen(false)} />

      <div className="adminShell">
        <aside className="adminSidebar enterpriseSidebar">
          <div className="adminMobileDrawerHead">
            <b>Pro Admin menyu</b>
            <button type="button" onClick={() => setAdminMobileMenuOpen(false)} aria-label="Menyuni yopish">×</button>
          </div>
          <div className="adminSidebarTop enterpriseSidebarTop">
            <div className="adminBrand enterpriseBrand">
              <BrandLogo brand={adminBrand} className="adminBrandMark enterpriseBrandMark" alt="Markaz logo" />
              <div><b>{adminBrand.name}</b><small>{adminBrand.subtitle}</small></div>
            </div>
            <span className="enterprisePlanBadge">PRO ADMIN</span>
          </div>

          <div className="enterpriseSidebarSnapshot">
            <div>
              <span>Bugungi fokus</span>
              <b>{focusCount}</b>
            </div>
            <div>
              <span>Aktivlik</span>
              <b>{activePercent}%</b>
            </div>
          </div>

          <nav className="adminMenuList enterpriseMenuList" aria-label="Admin menyu">
            {adminMenuGroups.map(section => (
              <div className="enterpriseMenuGroup" key={section.group}>
                <p className="enterpriseMenuCaption">{section.group}</p>
                {section.items.map(item => (
                  <button
                    type="button"
                    key={item.id}
                    className={adminTab === item.id ? 'active' : ''}
                    aria-current={adminTab === item.id ? 'page' : undefined}
                    onClick={() => { setAdminTab(item.id); setAdminMobileMenuOpen(false); scrollPageToTop('smooth'); }}
                  >
                    <i>{item.icon}</i>
                    <span><b>{item.title}</b><small>{item.desc}</small></span>
                    {item.badge && <em>{item.badge}</em>}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="adminSidebarTrust enterpriseSidebarTrust">
            <span>✓</span>
            <div><b>System stable</b><small>Backup, log va account nazorati yoqilgan</small></div>
          </div>
          <button type="button" className="sidebarLogoutBtn adminSidebarLogout enterpriseLogoutBtn" onClick={() => safeLogout(onLogout)}>
            <span>↪</span>
            <div><b>Chiqish</b><small>Accountdan xavfsiz chiqish</small></div>
          </button>
        </aside>

        <section className="adminContentPanel">
          {message && <div className="alert info adminMessage">{message}</div>}

          {adminTab === 'dashboard' && (
            <div className="adminTabPane dashboardProPane">
              <section className="dashboardProHero">
                <div className="dashboardHeroText">
                  <span className="dashboardBadge">Bugungi nazorat</span>
                  <h2>Platforma holati bir oynada</h2>
                  <p>Admin dashboardda faqat eng kerakli ko‘rsatkichlar turadi: arizalar, faol o‘quvchilar, to‘lov, speaking va progress.</p>
                  <div className="dashboardHeroActions">
                    <button type="button" className="primary small" onClick={() => setAdminTab('create')}>+ Account yaratish</button>
                    <button type="button" className="ghost small" onClick={() => setAdminTab('enrollments')}>Arizalarni ko‘rish</button>
                    <button type="button" className="ghost small" onClick={() => setAdminTab('content')}>Excel export</button>
                  </div>
                </div>
                <div className="dashboardHealthCard">
                  <div className="healthRing" style={{ '--p': activePercent }}><b>{activePercent}%</b><span>active</span></div>
                  <div className="healthList">
                    <span><b>{activeCount}</b> faol o‘quvchi</span>
                    <span><b>{unpaidCount}</b> to‘lanmagan</span>
                    <span><b>{expiringSoon.length}</b> muddati yaqin</span>
                  </div>
                </div>
              </section>

              <section className="dashboardProMetrics">
                <button type="button" className="dashMetricCard" onClick={() => { setAccountStatusFilter('all'); setAdminTab('accounts'); }}>
                  <i>U</i><span>Jami o‘quvchi</span><b>{stats.studentCount ?? usersTotal}</b><small>student accountlar</small>
                </button>
                <button type="button" className="dashMetricCard green" onClick={() => { setAccountStatusFilter('active'); setAdminTab('accounts'); }}>
                  <i>✅</i><span>Active</span><b>{activeCount}</b><small>kirish ruxsati bor</small>
                </button>
                <button type="button" className="dashMetricCard red" onClick={() => { setAccountStatusFilter('non-active'); setAdminTab('accounts'); }}>
                  <i>⛔</i><span>Non-active</span><b>{nonActiveCount}</b><small>bloklangan accountlar</small>
                </button>
                <button type="button" className="dashMetricCard" onClick={() => setAdminTab('progress')}>
                  <i>📈</i><span>O‘rtacha progress</span><b>{avgProgress}%</b><small>umumiy o‘zlashtirish</small>
                </button>
                <button type="button" className="dashMetricCard speaking" onClick={() => setAdminTab('progress')}>
                  <i>🎙</i><span>Speaking</span><b>{avgSpeaking}%</b><small>{stats.speakingCheckedWords || 0}/{stats.speakingTotalWords || 0} so‘z</small>
                </button>
                <button type="button" className="dashMetricCard amber" onClick={() => setAdminTab('certificates')}>
                  <i>S</i><span>Sertifikatlar</span><b>{stats.certificateCount ?? certTotal}</b><small>berilgan sertifikatlar</small>
                </button>
              </section>

              <section className="dashboardProGrid">
                <div className="dashboardPanel subjectDashboardPanel">
                  <div className="dashboardPanelHead">
                    <div><h3>Fanlar bo‘yicha holat</h3><p>Har bir fan uchun o‘quvchi soni va o‘rtacha progress.</p></div>
                    <button type="button" className="tinyLink" onClick={() => setAdminTab('progress')}>Progress</button>
                  </div>
                  <div className="dashSubjectList">
                    {subjectStats.slice(0, 7).map(item => (
                      <button type="button" className="dashSubjectRow" key={item.id} onClick={() => setAdminTab('accounts')}>
                        <div><b>{item.title}</b><span>{item.count} ta o‘quvchi · {item.active} active</span></div>
                        <div className="dashBar"><span style={{ width: `${Math.min(100, item.avg || 0)}%` }} /></div>
                        <strong>{item.avg}%</strong>
                      </button>
                    ))}
                    {!subjectStats.length && <p className="empty">Fanlar bo‘yicha ma’lumot yo‘q</p>}
                  </div>
                </div>

                <div className="dashboardPanel dashboardControlPanel">
                  <div className="dashboardPanelHead">
                    <div><h3>Tezkor boshqaruv</h3><p>Admin uchun eng kerakli harakatlar.</p></div>
                  </div>
                  <div className="quickActionGrid">
                    <button type="button" onClick={() => setAdminTab('create')}><b>+ Account</b><span>Yangi foydalanuvchi qo‘shish</span></button>
                    {isSuperAdmin && <button type="button" onClick={() => setAdminTab('centers')}><b>+ Markaz</b><span>Yangi o‘quv markaz ochish</span></button>}
                    <button type="button" onClick={() => setAdminTab('enrollments')}><b>Arizalar</b><span>{pendingEnrollments} ta yangi ariza</span></button>
                    <button type="button" onClick={() => setAdminTab('accounts')}><b>To‘lov</b><span>{paidCount} to‘langan · {unpaidCount} to‘lanmagan</span></button>
                    <button type="button" onClick={() => setAdminTab('progress')}><b>Speaking</b><span>{avgSpeaking}% umumiy speaking</span></button>
                    <button type="button" onClick={() => setAdminTab('content')}><b>Excel</b><span>Import / export qilish</span></button>
                    <button type="button" onClick={createBackup}><b>Backup</b><span>Ma’lumotlarni saqlash</span></button>
                  </div>
                  <div className="dashboardPaymentBox single">
                    <div><span>To‘lov nazorati</span><b>{paidCount}/{stats.studentCount ?? studentUsers.length}</b><small>to‘langan accountlar</small></div>
                  </div>
                </div>
              </section>
            </div>
          )}


          {adminTab === 'centers' && isSuperAdmin && (
            <div className="adminTabPane centersPane">
              <div className="adminTabHeader"><div><span className="eyebrow miniEyebrow">O‘quv markazlar</span><h2>Markaz yaratish va tahlil</h2><p className="muted">Katta admin yangi markaz ochadi, logo qo‘yadi va shu markaz uchun bosh admin login/parolini yaratadi.</p></div></div>

              <section className="centerManagerGrid">
                <form className="card centerCreateCard" onSubmit={createCenter}>
                  <div className="sectionHead"><div><h2>Yangi markaz yaratish</h2><p className="muted">Markaz admini faqat o‘z markazidagi o‘quvchi va o‘qituvchilarni boshqaradi.</p></div></div>
                  <label>Markaz nomi</label>
                  <input value={centerForm.name} onChange={e => setCenterForm({ ...centerForm, name: e.target.value })} placeholder="Masalan: ENGLISH Mock Chinoz" />
                  <label>Markaz logosi</label>
                  <input type="file" accept="image/*" onChange={handleCenterLogoFile} />
                  {centerForm.logoDataUrl && <div className="centerLogoPreview"><img src={centerForm.logoDataUrl} alt="Logo preview" /><span>Logo tayyor</span></div>}
                  <label>Bosh admin ism familyasi</label>
                  <input value={centerForm.adminFullName} onChange={e => setCenterForm({ ...centerForm, adminFullName: e.target.value })} placeholder="Masalan: Ali Valiyev" />
                  <label>Bosh admin login</label>
                  <input value={centerForm.adminUsername} onChange={e => setCenterForm({ ...centerForm, adminUsername: e.target.value })} placeholder="masalan: chinoz_admin" />
                  <label>Bosh admin parol</label>
                  <input value={centerForm.adminPassword} onChange={e => setCenterForm({ ...centerForm, adminPassword: e.target.value })} placeholder="kamida 6 ta belgi" />
                  <button className="primary">Markaz yaratish</button>
                </form>

                <section className="card centerAnalyticsCard">
                  <div className="sectionHead"><div><h2>Markazlar ro‘yxati</h2><p className="muted">Har bir markaz ichiga kirib o‘quvchi, o‘qituvchi va progressni ko‘rasiz.</p></div><b className="countBadge">{centerStatsList.length} ta</b></div>
                  <div className="centerCardsGrid">
                    {centerStatsList.map(center => (
                      <button type="button" className={`centerCard ${selectedCenterId === center.id ? 'active' : ''}`} key={center.id} onClick={async () => { setSelectedCenterId(center.id); await loadCenters(center.id); }}>
                        <div className="centerCardTop">
                          {center.logoDataUrl ? <img src={center.logoDataUrl} alt="" /> : <em>{(center.name || 'M').slice(0,2).toUpperCase()}</em>}
                          <div><b>{center.name}</b><span>{center.status || 'active'}</span></div>
                        </div>
                        <div className="centerMiniStats"><span>O‘quvchi <b>{center.students || 0}</b></span><span>O‘qituvchi <b>{center.teachers || 0}</b></span><span>Progress <b>{center.avgProgress || 0}%</b></span></div>
                      </button>
                    ))}
                  </div>
                </section>
              </section>

              {selectedCenter && (
                <section className="card selectedCenterCard">
                  <div className="sectionHead"><div><h2>{selectedCenter.name}</h2><p className="muted">Markaz ichidagi accountlar, darajalar va ishlash foizlari.</p></div><button type="button" className="ghost small" onClick={() => loadCenters(selectedCenter.id)}>Yangilash</button></div>
                  <div className="selectedCenterStats">
                    <div><span>O‘quvchi</span><b>{selectedCenter.students || 0}</b></div>
                    <div><span>O‘qituvchi</span><b>{selectedCenter.teachers || 0}</b></div>
                    <div><span>Admin</span><b>{selectedCenter.admins || 0}</b></div>
                    <div><span>Progress</span><b>{selectedCenter.avgProgress || 0}%</b></div>
                    <div><span>Speaking</span><b>{selectedCenter.avgSpeaking || 0}%</b></div>
                  </div>
                  <div className="centerLevelGrid">
                    {(selectedCenter.levelStats || []).map(level => <div key={level.level}><span>{level.level}</span><b>{level.count}</b><small>{level.avg}% o‘rtacha</small></div>)}
                  </div>
                  <div className="table centerUsersTable">
                    <div className="tr head"><b>Ism familya</b><b>Login</b><b>Rol/Fan</b><b>Daraja</b><b>Progress</b><b>Speaking</b><b>Status</b></div>
                    {selectedCenterUsers.map(user => (
                      <div className="tr" key={user.id}>
                        <span>{user.fullName}</span>
                        <span>{user.username}</span>
                        <span>{user.role} · {user.subjectTitle}</span>
                        <span>{user.role === 'student' ? (user.currentLevel || 'Beginner') : '—'}</span>
                        <span>{user.role === 'student' ? `${user.progressPercent || 0}%` : '—'}</span>
                        <span>{user.role === 'student' ? `${user.speakingPercent || 0}%` : '—'}</span>
                        <span className={`status ${user.status}`}>{user.status}</span>
                      </div>
                    ))}
                    {!selectedCenterUsers.length && <p className="empty">Bu markazda hali account yo‘q</p>}
                  </div>
                </section>
              )}
            </div>
          )}

          {adminTab === 'create' && (
            <div className="adminTabPane">
              <div className="adminTabHeader"><div><span className="eyebrow miniEyebrow">Account yaratish</span><h2>Yangi foydalanuvchi qo‘shish</h2><p className="muted">Student, o‘qituvchi yoki admin accountni alohida forma orqali yarating.</p></div></div>
              <section className="card createCard createSwitcherCard">
                <div className="sectionHead">
                  <div>
                    <h2>Account yaratish</h2>
                    <p className="muted">Avval qaysi turdagi account yaratishni tanlang. Tanlangan tugma active bo‘ladi va forma ekranga chiqadi.</p>
                  </div>
                  <div className="createTabs">
                    <button type="button" className={activeCreateRole === 'student' ? 'active' : ''} onClick={() => openCreatePanel('student')}>Foydalanuvchi yaratish</button>
                    <button type="button" className={activeCreateRole === 'teacher' ? 'active' : ''} onClick={() => openCreatePanel('teacher')}>O‘qituvchi yaratish</button>
                    {isSuperAdmin && <button type="button" className={activeCreateRole === 'admin' ? 'active' : ''} onClick={() => openCreatePanel('admin')}>Admin yaratish</button>}
                  </div>
                </div>

                {!activeCreateRole && <div className="createEmpty">Forma ochilishi uchun yuqoridagi tugmalardan birini bosing.</div>}

                {activeCreateRole && (
                  <form className="formGrid activeCreateForm" onSubmit={createUser}>
                    <label>Role</label>
                    <input value={activeCreateRole === 'admin' ? 'Admin' : activeCreateRole === 'teacher' ? 'O‘qituvchi' : 'Foydalanuvchi'} readOnly />
                    {isSuperAdmin && (
                      <>
                        <label>Markaz</label>
                        <select value={form.centerId || selectedCenterId || 'center_main'} onChange={e => setForm({ ...form, centerId: e.target.value })}>
                          {visibleCenters.map(center => <option key={center.id} value={center.id}>{center.name}</option>)}
                        </select>
                      </>
                    )}
                    <label>Fan</label>
                    <select value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })}>
                      {activeCreateRole === 'admin' && canAll && <option value="all">Barcha fanlar</option>}
                      {subjectOptions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                    </select>
                    <label>Login</label>
                    <input value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} placeholder="masalan: ali_english" />
                    <label>Parol</label>
                    <input value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="masalan: ali123" />
                    <label>Ism familya</label>
                    <input value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} placeholder="Ali Valiyev" />
                    <label>Tug‘ilgan sana</label>
                    <input type="date" value={form.birthDate} onChange={e => setForm({ ...form, birthDate: e.target.value })} />
                    <label>Holati</label>
                    <select value={form.isActive ? 'active' : 'non-active'} disabled={form.paymentStatus === 'unpaid'} onChange={e => setForm({ ...form, isActive: e.target.value === 'active' })}>
                      <option value="active">Active</option>
                      <option value="non-active">Non-active</option>
                    </select>
                    <label>Tugash vaqti</label>
                    <input type="date" value={form.expiresAt || ''} onChange={e => setForm({ ...form, expiresAt: e.target.value })} />
                    <label>To‘lov holati</label>
                    <select value={form.paymentStatus || 'paid'} onChange={e => setForm({ ...form, paymentStatus: e.target.value, isActive: e.target.value === 'paid' })}>
                      <option value="paid">To‘langan</option>
                      <option value="unpaid">To‘lanmagan</option>
                    </select>
                    <label>To‘lov izohi</label>
                    <input value={form.paymentNote || ''} onChange={e => setForm({ ...form, paymentNote: e.target.value })} placeholder="Masalan: May oyi to‘lovi" />
                    {activeCreateRole === 'student' && (
                      <>
                        <label>Hamma mavzular</label>
                        <label className="inlineCheck adminUnlimitedCheck">
                          <input type="checkbox" checked={(form.topicAccessMode || (form.allowUnlimitedTopics ? 'unlimited' : 'daily')) === 'unlimited'} onChange={e => setForm({ ...form, topicAccessMode: e.target.checked ? 'unlimited' : 'daily', allowUnlimitedTopics: e.target.checked })} />
                          <span>Cheklovsiz: hamma mavzular ochiq bo‘lsin</span>
                        </label>
                      </>
                    )}
                    <button className="primary">{activeCreateRole === 'admin' ? 'Admin yaratish' : activeCreateRole === 'teacher' ? 'O‘qituvchi yaratish' : 'Foydalanuvchi yaratish'}</button>
                  </form>
                )}
              </section>
            </div>
          )}

          {adminTab === 'enrollments' && (
            <div className="adminTabPane">
              <div className="adminTabHeader"><div><span className="eyebrow miniEyebrow">Arizalar</span><h2>Kursga yozilish arizalari</h2><p className="muted">Yangi arizalarni ko‘rib chiqing, bog‘lanilgan va yakunlangan holatga o‘tkazing.</p></div></div>
              <section className="card">
                <div className="sectionHead"><h2>Kursga yozilish arizalari</h2><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Ism, telefon, fan yoki status bo‘yicha qidirish..." /><b className="countBadge">{filteredEnrollments.length} ta</b></div>
                <div className="cardsGrid">
                  {filteredEnrollments.map(item => (
                    <div className="miniCard" key={item.id}>
                      <div className="miniTop"><b>{item.fullName}</b><span className={`status ${item.status}`}>{item.status}</span></div>
                      <p>{item.languageTitle} · {fmtDate(item.birthDate)}</p>
                      <p>📞 {item.phone} · 💬 {item.telegram}</p>
                      <small>Yuborilgan: {fmtDate(item.createdAt)}</small>
                      <div className="actions compact">
                        <button className="primary small" onClick={() => fillFromEnrollment(item)}>Login yaratish</button>
                        <button className="ghost small" onClick={() => updateEnrollment(item, 'contacted')}>Bog‘lanildi</button>
                        <button className="ghost small" onClick={() => updateEnrollment(item, 'done')}>Yakunlandi</button>
                      </div>
                    </div>
                  ))}
                  {!filteredEnrollments.length && <p className="empty">Hali ariza yo‘q</p>}
                </div>
              </section>
            </div>
          )}

          {adminTab === 'plans' && (
            <div className="adminTabPane plansPane">
              <section className="card plansCard">
                <div className="plansHeader">
                  <div>
                    <span className="adminLabel soft">Rejalar</span>
                    <h2>O‘quvchilar kun rejasi</h2>
                    <p className="muted">O‘quvchilarni belgilang, dars kunlarini biriktiring yoki Elementary / Pre-Intermediate kabi darajalarni ochib bering.</p>
                  </div>
                  <div className="plansHeaderCount">{selectedPlanUsers.length} ta tanlandi</div>
                </div>

                <div className="planBulkPanel">
                  <div className="planBulkTop">
                    <label className="planSelectAll">
                      <input type="checkbox" checked={planUsers.length > 0 && selectedPlanUsers.length === planUsers.length} onChange={toggleAllPlanUsers} />
                      <span>Umumiy belgilash</span>
                    </label>
                    <input className="planSearchInput" value={planQuery} onChange={e => setPlanQuery(e.target.value)} placeholder="Ism, login yoki fan bo‘yicha qidirish..." />
                    <button type="button" className="primary planAssignButton" onClick={assignPlanDays}>Saqlash</button>
                  </div>

                  <div className="planDayChips">
                    {planDayOptions.map(day => (
                      <button
                        type="button"
                        key={day}
                        className={`planDayChip ${selectedPlanDays.includes(day) ? 'active' : ''}`}
                        onClick={() => togglePlanDay(day)}
                      >
                        {day}
                      </button>
                    ))}
                  </div>

                  <div className="planLevelUnlockBox">
                    <b>Qo‘lda daraja ochish</b>
                    <small>Tanlangan o‘quvchilarga shu darajani ochib beradi. Mavzular esa baribir admin belgilagan kun va 90% qoidasi bo‘yicha bittalab ochiladi.</small>
                    <div className="planDayChips levelChips">
                      {allLevels.filter(lv => lv !== 'Beginner').map(lv => (
                        <button
                          type="button"
                          key={lv}
                          className={`planDayChip levelChip ${selectedPlanLevels.includes(lv) ? 'active' : ''}`}
                          onClick={() => togglePlanLevel(lv)}
                        >
                          {lv}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="topicModeToggleBox">
                    <b>Mavzu ochish rejimi</b>
                    <label className={`planUnlimitedToggle ${selectedTopicAccessMode === 'unlimited' ? 'active' : ''}`}>
                      <input type="radio" name="topicAccessMode" checked={selectedTopicAccessMode === 'unlimited'} onChange={() => setSelectedTopicAccessMode('unlimited')} />
                      <span>Cheklovsiz — hamma mavzular ochiq</span>
                    </label>
                    <label className={`planUnlimitedToggle ${selectedTopicAccessMode === 'daily' ? 'active' : ''}`}>
                      <input type="radio" name="topicAccessMode" checked={selectedTopicAccessMode === 'daily'} onChange={() => setSelectedTopicAccessMode('daily')} />
                      <span>Belgilangan kunda faqat 1 ta yangi mavzu ochilsin</span>
                    </label>
                  </div>
                </div>

                <div className="plansTable">
                  <div className="plansTr plansHead">
                    <span></span>
                    <span>Ism familya</span>
                    <span>Login</span>
                    <span>Fan / daraja</span>
                    <span>Status</span>
                    <span>Biriktirilgan kunlar</span>
                    <span>Ochiq darajalar</span>
                    <span>Mavzu huquqi</span>
                  </div>

                  {plansLoading ? (
                    <div className="plansEmpty">Yuklanmoqda...</div>
                  ) : planUsers.length ? planUsers.map(user => (
                    <div className={`plansTr ${selectedPlanUsers.includes(user.id) ? 'selected' : ''}`} key={user.id}>
                      <label className="planCheckboxCell">
                        <input type="checkbox" checked={selectedPlanUsers.includes(user.id)} onChange={() => togglePlanUser(user.id)} />
                      </label>
                      <div className="planNameCell">
                        <b>{user.fullName || user.username}</b>
                        <small>{user.currentTopicTitle || 'Mavzu boshlanmagan'}</small>
                      </div>
                      <span>{user.username}</span>
                      <span>{user.subjectTitle || user.subject} · {user.currentLevel || 'Beginner'}</span>
                      <span className={`planStatus ${user.status === 'active' ? 'active' : 'inactive'}`}>{user.status}</span>
                      <div className="planDaysBadges">
                        {(user.planDays || []).length ? user.planDays.map(day => <span key={day} className="planDayBadge">{day}</span>) : <span className="planEmptyDays">Kun biriktirilmagan</span>}
                      </div>
                      <div className="planDaysBadges levelBadges">
                        {['Beginner', ...(user.unlockedLevels || [])].map(lv => <span key={lv} className="planDayBadge levelBadge">{lv}</span>)}
                      </div>
                      <div className="planDaysBadges">
                        {(user.topicAccessMode || (user.allowUnlimitedTopics ? 'unlimited' : 'daily')) === 'unlimited' ? <span className="planDayBadge unlimitedBadge">Cheklovsiz</span> : <span className="planDayBadge">Kuniga 1 ta</span>}
                      </div>
                    </div>
                  )) : (
                    <div className="plansEmpty">O‘quvchi topilmadi</div>
                  )}
                </div>
              </section>
            </div>
          )}

          {adminTab === 'accounts' && (
            <div className="adminTabPane accountsPane">
              <section className="card modernAccountCard">
                <div className="accountToolbar">
                  <div>
                    <span className="adminLabel soft">Accountlar</span>
                    <h2>Yaratilgan accountlar</h2>
                    <p className="muted">O‘quvchi, o‘qituvchi va admin accountlarini shu yerdan boshqaring.</p>
                  </div>
                  <button type="button" className="primary small" onClick={() => setAdminTab('create')}>+ Account yaratish</button>
                </div>

                <div className="accountControls cleanControls">
                  <input value={accountQuery} onChange={e => setAccountQuery(e.target.value)} placeholder="Ism, login, fan, daraja yoki status bo‘yicha qidirish..." />
                  <select value={accountStatusFilter} onChange={e => setAccountStatusFilter(e.target.value)}>
                    <option value="all">Barcha statuslar</option>
                    <option value="active">Active</option>
                    <option value="non-active">Non-active</option>
                    <option value="expired">Expired</option>
                  </select>
                  <b className="countBadge">{usersTotal} ta</b>
                </div>

                {isSuperAdmin && selectedAccountsCount > 0 && (
                  <div className="bulkDeletePanel">
                    <b>{selectedAccountsCount} ta account belgilandi</b>
                    <button type="button" className="dangerBulkBtn" onClick={deleteSelectedAccounts}>🗑 Belgilanganlarni o‘chirish</button>
                    <button type="button" className="ghost small" onClick={() => setSelectedAccountIds([])}>Bekor qilish</button>
                    <button type="button" className="bulkCloseBtn" onClick={() => setSelectedAccountIds([])}>×</button>
                  </div>
                )}

                <div className={`table usersTable adminAccountsTable bulkSelectMode ${isSuperAdmin ? 'withCenters' : ''}`}>
                  <div className="tr head">
                    {isSuperAdmin && <label className="accountCheck"><input type="checkbox" checked={allVisibleAccountsSelected} disabled={!selectableAccountIds.length} onChange={toggleAllVisibleAccounts} /><span></span></label>}
                    <b>Ism familya</b><b>Login</b>{isSuperAdmin && <b>Markaz</b>}<b>Rol/Fan</b><b>Daraja</b><b>Speaking</b><b>Status</b><b>To‘lov</b><b>Muddat</b><b>Action</b>
                  </div>
                  {filteredUsers.map(user => (
                    <div className={`tr ${selectedAccountIds.includes(user.id) ? 'checkedRow' : ''} ${selectedUserId === user.id ? 'selectedRow' : ''}`} key={user.id}>
                      {isSuperAdmin && <label className="accountCheck"><input type="checkbox" checked={selectedAccountIds.includes(user.id)} disabled={user.id === meta?.currentAdmin?.id} onChange={() => toggleAccountSelection(user.id)} /><span></span></label>}
                      <span className="personCell"><em>{getInitials(user.fullName)}</em><span><b>{user.fullName}</b><small>{user.role === 'student' ? (user.currentTopicTitle || 'Boshlanmagan') : 'Panel foydalanuvchisi'}</small></span></span>
                      <span>{user.username}</span>
                      {isSuperAdmin && <span>{user.centerName || '—'}</span>}
                      <span>{user.role} · {user.subjectTitle}</span>
                      <span>{user.role === 'student' ? (user.currentLevel || 'Beginner') : '—'}</span>
                      <span>{user.role === 'student' ? `${user.speakingPercent || 0}% · ${user.speakingCheckedWords || 0}/${user.speakingTotalWords || 0}` : '—'}</span>
                      <span className={`status ${user.status}`}>{user.status}</span>
                      <span className={`status pay-${user.paymentStatus || 'paid'}`}>{user.paymentStatusTitle || user.paymentStatus || 'To‘langan'}</span>
                      <span>{fmtDate(user.expiresAt)}</span>
                      <span className="rowActions accountRowActions">
                        {user.role === 'student' && <button className="primary small observeBtn accountObserveBtn" onClick={() => selectUserProgress(user.id)}>Kuzatish</button>}
                        <button type="button" className={`small ${user.status === 'active' ? 'dangerSoft' : 'successSoft'}`} disabled={user.paymentStatus === 'unpaid'} title={user.paymentStatus === 'unpaid' ? 'To‘lanmagan o‘quvchi avtomatik non-active bo‘ladi' : ''} onClick={() => toggleUserStatus(user)}>{user.paymentStatus === 'unpaid' ? 'To‘lov yo‘q' : user.status === 'active' ? 'Non-active' : 'Active'}</button>
                        <select defaultValue={user.paymentStatus || 'paid'} onChange={e => updateUser(user, { paymentStatus: e.target.value, isActive: e.target.value === 'paid' })}>
                          <option value="paid">To‘langan</option>
                          <option value="unpaid">To‘lanmagan</option>
                        </select>
                        <input type="date" defaultValue={user.expiresAt || ''} onBlur={e => updateUser(user, { expiresAt: e.target.value })} />
                        {isSuperAdmin && user.id !== meta?.currentAdmin?.id && (
                          <button type="button" className="small dangerSoft deleteAccountBtn" onClick={() => deleteUserAccount(user)}>O‘chirish</button>
                        )}
                      </span>
                    </div>
                  ))}
                  {!filteredUsers.length && <p className="empty">Foydalanuvchi topilmadi</p>}
                </div>
                <div className="paginationBar">
                  <button type="button" className="ghost small" disabled={usersPage <= 1} onClick={() => setUsersPage(p => Math.max(1, p - 1))}>← Oldingi</button>
                  <span>{usersPage} / {usersTotalPages} · jami {usersTotal}</span>
                  <button type="button" className="ghost small" disabled={usersPage >= usersTotalPages} onClick={() => setUsersPage(p => Math.min(usersTotalPages, p + 1))}>Keyingi →</button>
                </div>
              </section>
            </div>
          )}

          {adminTab === 'progress' && (
            <div className="adminTabPane progressControlPane">
              <div className="adminTabHeader"><div><span className="eyebrow miniEyebrow">Progress</span><h2>O‘quvchilar progress jadvali</h2><p className="muted">Bu yerda barcha o‘quvchilar ko‘rinadi. “Kuzatish” tugmasi bosilsa, o‘sha o‘quvchining fani, darajasi, kelgan mavzusi va har bir mavzudan olgan foizi chiqadi.</p></div><button type="button" className="primary small refreshBtn" onClick={() => loadProgressUsers()}>Yangilash</button></div>

              <section className="card progressLookupCard">
                <div className="sectionHead progressSectionHead">
                  <div>
                    <h2>Umumiy o‘quvchilar jadvali</h2>
                    <p className="muted">Ism, login, fan yoki daraja bo‘yicha qidiring va kerakli o‘quvchini kuzating.</p>
                  </div>
                  <b className="countBadge">{progressUsers.length} ta</b>
                </div>
                <div className="progressFilters cleanControls">
                  <input value={progressQuery} onChange={e => setProgressQuery(e.target.value)} placeholder="Ism, login, fan yoki daraja bo‘yicha qidirish..." />
                  <select value={progressSubjectFilter} onChange={e => setProgressSubjectFilter(e.target.value)}>
                    <option value="all">Barcha fanlar</option>
                    {subjectOptions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </select>
                  <select value={progressStatusFilter} onChange={e => setProgressStatusFilter(e.target.value)}>
                    <option value="all">Barcha statuslar</option>
                    <option value="active">Active</option>
                    <option value="non-active">Non-active</option>
                    <option value="expired">Expired</option>
                  </select>
                </div>

                <div className="table usersTable progressStudentsTable">
                  <div className="tr head"><b>O‘quvchi</b><b>Login</b><b>Fan</b><b>Daraja</b><b>Kelgan mavzu</b><b>Mavzu foizi</b><b>Umumiy</b><b>Speaking</b><b>Action</b></div>
                  {progressLoading && <p className="empty">Yuklanmoqda...</p>}
                  {!progressLoading && progressUsers.map(user => (
                    <div className={`tr ${selectedUserId === user.id ? 'selectedRow' : ''}`} key={user.id}>
                      <span className="personCell"><em>{getInitials(user.fullName)}</em><span><b>{user.fullName}</b><small>{user.status === 'active' ? 'Faol o‘quvchi' : user.status}</small></span></span>
                      <span>{user.username}</span>
                      <span>{user.subjectTitle}</span>
                      <span><b className="levelMiniBadge">{user.currentLevel || 'Beginner'}</b></span>
                      <span>{user.currentTopicNo ? `${user.currentTopicNo}-mavzu` : (user.currentTopicTitle || 'Boshlanmagan')}</span>
                      <span><div className="progressInline"><i style={{ width: `${Math.min(100, user.currentTopicScore || 0)}%` }} /></div><b>{user.currentTopicScore || 0}%</b></span>
                      <span><div className="progressInline green"><i style={{ width: `${Math.min(100, user.progressPercent || 0)}%` }} /></div><b>{user.progressPercent || 0}%</b></span>
                      <span>{user.speakingPercent || 0}% · {user.speakingCheckedWords || 0}/{user.speakingTotalWords || 0}</span>
                      <span><button type="button" className="primary small observeBtn" onClick={() => selectUserProgress(user.id)}>Kuzatish</button></span>
                    </div>
                  ))}
                  {!progressLoading && !progressUsers.length && <p className="empty">O‘quvchi topilmadi</p>}
                </div>
              </section>

              {selectedUserData && selectedUserData.role === 'student' && (
                <section className="card studentProgressAdminCard studentProgressDetailCard">
                  <div className="sectionHead progressDetailHead">
                    <div>
                      <span className="adminLabel soft">Kuzatish oynasi</span>
                      <h2>{selectedUserData.fullName}</h2>
                      <p className="muted">Fani, darajasi, qaysi mavzuga kelgani va mavzular bo‘yicha olgan foizlari.</p>
                    </div>
                    <button type="button" className="ghost small" onClick={() => { setSelectedUser(null); setSelectedUserId(''); }}>Yopish</button>
                  </div>
                  <div className="studentProgressBox">
                    <div className="progressSummaryGrid progressWatchSummary">
                      <div><span>Fan</span><b>{selectedUserData.subjectTitle}</b></div>
                      <div><span>Daraja</span><b>{selectedUserData.currentLevel || 'Beginner'}</b></div>
                      <div><span>Kelgan mavzu</span><b>{selectedUserData.currentTopicNo ? `${selectedUserData.currentTopicNo}-mavzu` : 'Boshlanmagan'}</b><small>{selectedUserData.currentTopicTitle || 'Hali test boshlanmagan'}</small></div>
                      <div><span>Shu mavzu foizi</span><b>{selectedUserData.currentTopicScore || 0}%</b></div>
                      <div><span>Umumiy progress</span><b>{selectedUserData.progressPercent || 0}%</b></div>
                      <div><span>Speaking</span><b>{selectedUserData.speakingPercent || 0}%</b><small>{selectedUserData.speakingCheckedWords || 0}/{selectedUserData.speakingTotalWords || 0} ta so‘z</small></div>
                    </div>
                    <div className="topicProgressGroups progressTopicGrid">
                      {selectedTopicGroups.map(group => (
                        <div className={`topicProgressGroup ${!group.unlocked ? 'locked' : ''}`} key={group.level}>
                          <div className="topicGroupHead">
                            <h3>{group.level} daraja</h3>
                            <span>{group.unlocked ? `Yakuniy: ${group.finalBest || 0}%` : 'Yopiq'}</span>
                          </div>
                          <div className="topicProgressList compactTopicList">
                            {group.topics.map(topic => (
                              <div className="topicProgressRow" key={`${group.level}-${topic.topicNo}`}>
                                <div className="topicProgressInfo">
                                  <b>{topic.topicNo}. {topic.title}</b>
                                  <span>{topic.unlocked ? (topic.completed ? 'O‘zlashtirilgan' : 'Jarayonda') : 'Yopiq'} · urinish: {topic.attempts || 0}</span>
                                  <small className="speakingTopicHint">🎤 Speaking: {topic.speakingScore || 0}% · {topic.speakingCheckedWords || 0}/{topic.speakingTotalWords || 30} so‘z</small>
                                </div>
                                <div className="miniPercent"><div style={{ width: `${Math.min(100, topic.bestScore || 0)}%` }} /></div>
                                <strong>{topic.bestScore || 0}%</strong>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              )}
            </div>
          )}

          {adminTab === 'certificates' && (
            <div className="adminTabPane">
              <div className="adminTabHeader"><div><span className="eyebrow miniEyebrow">Sertifikatlar</span><h2>Sertifikatlar ro‘yxati</h2><p className="muted">Berilgan sertifikatlarni ID, ism-familya yoki fan orqali toping.</p></div></div>
              <section className="card adminCertificatesCard">
                <div className="sectionHead certSectionHead">
                  <div>
                    <h2>Sertifikatlar</h2>
                    <p className="muted">Berilgan sertifikatlar ketma-ket ro‘yxatda ko‘rinadi. Ism-familya, ID yoki fan bo‘yicha tez qidiring.</p>
                  </div>
                  <b className="countBadge">{certTotal} ta</b>
                </div>
                <div className="certificateFilters">
                  <input value={certQuery} onChange={e => setCertQuery(e.target.value)} placeholder="Ism familya yoki sertifikat ID yozing..." />
                  <select value={certSubject} onChange={e => setCertSubject(e.target.value)}>
                    <option value="all">Barcha fanlar</option>
                    {subjectOptions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </select>
                </div>
                <div className="certificateList">
                  {filteredCertificates.map(c => (
                    <div className="certificateRow" key={c.id}>
                      <div className="certificateRowMain">
                        <b>{c.fullName}</b>
                        <span>{c.subjectTitle || c.language} · {c.level} · {c.score}%</span>
                        <small>ID: {c.code || c.id}</small>
                      </div>
                      <div className="certificateRowDate">{fmtDate(c.createdAt)}</div>
                      <div className="certificateRowActions">
                        <button type="button" className="primary small certificateActionBtn" onClick={() => openCertificate(c)}>👁️ Ko‘rish</button>
                        <button type="button" className="ghost small certificateActionBtn" onClick={() => downloadCertificateFile(c)}>⬇️ Rasm yuklash</button>
                      </div>
                    </div>
                  ))}
                  {!filteredCertificates.length && <p className="empty">Sertifikat yo‘q</p>}
                </div>
                <div className="paginationBar">
                  <button type="button" className="ghost small" disabled={certPage <= 1} onClick={() => setCertPage(p => Math.max(1, p - 1))}>← Oldingi</button>
                  <span>{certPage} / {certTotalPages} · jami {certTotal}</span>
                  <button type="button" className="ghost small" disabled={certPage >= certTotalPages} onClick={() => setCertPage(p => Math.min(certTotalPages, p + 1))}>Keyingi →</button>
                </div>
              </section>
            </div>
          )}

          {adminTab === 'shopOrders' && <AdminShopOrdersPanel />}

          {adminTab === 'content' && (
            <div className="adminTabPane">
              <div className="adminTabHeader"><div><span className="eyebrow miniEyebrow">Kontent</span><h2>Kontent va Excel boshqaruvi</h2><p className="muted">CSV import/export, mavzu, YouTube, vocabulary va test savollarini boshqaring.</p></div></div>
              <section className="card excelCard">
                <div className="sectionHead"><div><h2>Excel / CSV import-export</h2><p className="muted">O‘quvchilar, natijalar va sertifikatlarni Excel ochadigan CSV fayl ko‘rinishida yuklab oling.</p></div></div>
                <div className="exportButtons">
                  <button type="button" className="primary small" onClick={() => downloadAdminFile('/api/admin/export/users.csv', 'users-export.csv')}>Accountlar Excel</button>
                  <button type="button" className="ghost small" onClick={() => downloadAdminFile('/api/admin/export/results.csv', 'results-export.csv')}>Natijalar Excel</button>
                  <button type="button" className="ghost small" onClick={() => downloadAdminFile('/api/admin/export/certificates.csv', 'certificates-export.csv')}>Sertifikatlar Excel</button>
                </div>
                <div className="importBox">
                  <textarea value={importText} onChange={e => setImportText(e.target.value)} placeholder={'CSV ustunlari: login, password, ism familya, fan, tugilgan sana, muddat, tolov\nali01,student123,Ali Valiyev,english,2010-05-01,2026-08-01,paid'} />
                  <button type="button" className="primary" onClick={importUsersCsv} disabled={!importText.trim()}>CSVdan o‘quvchi import qilish</button>
                </div>
              </section>

              <section className="card topicEditorCard">
                <div className="sectionHead"><div><h2>Test va mavzu kontentini boshqarish</h2><p className="muted">Admin YouTube link, qo‘shimcha izoh, vocabulary va tanlash savollarini mavzuga bog‘lab saqlaydi.</p></div><button type="button" className="ghost small" onClick={loadTopicEditor}>Mavzuni yuklash</button></div>
                <form className="topicEditorForm" onSubmit={saveTopicEditor}>
                  <select value={topicEditor.language} onChange={e => setTopicEditor({ ...topicEditor, language: e.target.value })}>{subjectOptions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select>
                  <select value={topicEditor.level} onChange={e => setTopicEditor({ ...topicEditor, level: e.target.value })}>{allLevels.map(l => <option key={l} value={l}>{l}</option>)}</select>
                  <input type="number" min="1" max="15" value={topicEditor.topicNo} onChange={e => setTopicEditor({ ...topicEditor, topicNo: e.target.value })} />
                  <input value={topicEditor.youtubeVideoUrl} onChange={e => setTopicEditor({ ...topicEditor, youtubeVideoUrl: e.target.value })} placeholder="YouTube video link" />
                  <textarea value={topicEditor.extraNote} onChange={e => setTopicEditor({ ...topicEditor, extraNote: e.target.value })} placeholder="Qo‘shimcha tushuntirish matni" />
                  <textarea value={topicEditor.vocabularyText} onChange={e => setTopicEditor({ ...topicEditor, vocabularyText: e.target.value })} placeholder={'Vocabulary format: word|tarjima|example\nstudent|o‘quvchi|I am a student.'} />
                  <textarea value={topicEditor.questionsText} onChange={e => setTopicEditor({ ...topicEditor, questionsText: e.target.value })} placeholder={'Savol format: Savol?|A variant|B variant|C variant|D variant|0|izoh\nTo‘g‘ri gapni tanlang|I am a student|I is student|I student|I are student|0|I bilan am'} />
                  <button className="primary">Mavzu kontentini saqlash</button>
                </form>
              </section>
            </div>
          )}

          {adminTab === 'logs' && (
            <div className="adminTabPane">
              <div className="adminTabHeader"><div><span className="eyebrow miniEyebrow">Loglar</span><h2>Xavfsizlik va system loglari</h2><p className="muted">Kim nima qilgani va texnik xatolar alohida nazorat qilinadi.</p></div></div>
              <section className="adminOpsGrid">
                <div className="card opsCard">
                  <div className="sectionHead"><div><h2>Admin action log</h2><p className="muted">Kim nima qilgani yozilib boradi.</p></div></div>
                  <div className="logList">{actionLogs.map(log => <div className="logRow" key={log.id}><b>{log.action}</b><span>{log.actorName} · {fmtDateTime(log.createdAt)}</span><small>{log.target}</small></div>)}{!actionLogs.length && <p className="empty">Action log yo‘q</p>}</div>
                </div>
                <div className="card opsCard">
                  <div className="sectionHead"><div><h2>System error log</h2><p className="muted">Backend xatolari va texnik ogohlantirishlar.</p></div></div>
                  <div className="logList">{systemLogs.map(log => <div className={`logRow ${log.level}`} key={log.id}><b>{log.level}</b><span>{log.message}</span><small>{fmtDateTime(log.createdAt)}</small></div>)}{!systemLogs.length && <p className="empty">System log toza</p>}</div>
                </div>
              </section>
            </div>
          )}

          {adminTab === 'settings' && (
            <div className="adminTabPane">
              <div className="adminTabHeader"><div><span className="eyebrow miniEyebrow">Sozlamalar</span><h2>Panel sozlamalari</h2><p className="muted">Admin panel ko‘rinishi, xavfsizlik va umumiy ma’lumotlar shu joyda jamlanadi.</p></div></div>
              <section className="card settingsCard">
                <div className="settingsGrid">
                  <div><span>Joriy admin</span><b>{adminDisplayName}</b><small>Panelga kirgan foydalanuvchi</small></div>
                  <div><span>Faol status</span><b>{activeCount}</b><small>Hozir active o‘quvchilar</small></div>
                  <div><span>To‘lanmagan</span><b>{studentUsers.filter(user => (user.paymentStatus || 'paid') === 'unpaid').length}</b><small>Avtomatik non-active qilinadi</small></div>
                  <div><span>Backup</span><b>{backups.length}</b><small>Saqlangan backup fayllar</small></div>
                </div>
              </section>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}


function TeacherPanel({ user, onLogout }) {
  const [dashboard, setDashboard] = useState(null);
  const [students, setStudents] = useState([]);
  const [query, setQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState(null);
  const [message, setMessage] = useState('');
  const [teacherTab, setTeacherTab] = useState('overview');

  async function loadTeacherData() {
    const [d, s] = await Promise.all([
      api('/api/teacher/dashboard'),
      api(`/api/teacher/students?page=1&pageSize=50&search=${encodeURIComponent(query)}`)
    ]);
    setDashboard(d);
    setStudents(s.students || []);
  }
  useEffect(() => { loadTeacherData().catch(err => setMessage(err.message)); }, [query]);

  async function openProgress(id) {
    try {
      const data = await api(`/api/teacher/students/${id}/progress`);
      setSelectedUser(data.user);
      setTeacherTab('progress');
    } catch (err) {
      setMessage(err.message);
    }
  }

  const topicGroups = selectedUser?.topicProgress || [];
  const teacherDisplayName = user?.fullName || user?.username || 'O‘qituvchi';
  const teacherInitials = teacherDisplayName.split(/\s+/).filter(Boolean).map(part => part[0]).join('').slice(0, 2).toUpperCase() || 'T';
  const teacherBrand = panelBrand(user, { subtitle: 'Teacher Workspace' });
  const teacherStats = dashboard?.stats || {};
  const teacherNav = [
    { id: 'overview', icon: '🚀', title: 'Overview', desc: 'Umumiy nazorat', badge: teacherStats.students ? String(teacherStats.students) : '' },
    { id: 'students', icon: '⚙️', title: 'O‘quvchilar', desc: 'Ro‘yxat va qidiruv', badge: students.length ? String(students.length) : '' },
    { id: 'progress', icon: '📊', title: 'Progress', desc: selectedUser ? selectedUser.fullName : 'O‘quvchi tanlang' }
  ];

  return (
    <main className="teacherEnterprisePage teacherPage">
      <aside className="accountSidebar teacherSidebar">
        <div className="accountSidebarBrand">
          <BrandLogo brand={teacherBrand} className="accountBrandMark" alt="Markaz logo" />
          <div>
            <b>{teacherBrand.name}</b>
            <span>{teacherBrand.subtitle}</span>
          </div>
          <em className="accountSidebarBadge">TEACHER</em>
        </div>

        <div className="accountSidebarProfile">
          <strong>{teacherInitials}</strong>
          <div>
            <b>{teacherDisplayName}</b>
            <span>{dashboard?.subjectTitle || user?.subjectTitle || 'Fan'} nazorati</span>
          </div>
        </div>

        <div className="accountSidebarMetrics">
          <div><span>O‘quvchi</span><b>{teacherStats.students || 0}</b></div>
          <div><span>O‘rtacha</span><b>{teacherStats.avgProgress || 0}%</b></div>
        </div>

        <nav className="accountSidebarNav" aria-label="O‘qituvchi menyu">
          {teacherNav.map(item => (
            <button type="button" key={item.id} className={teacherTab === item.id ? 'active' : ''} onClick={() => { setTeacherTab(item.id); scrollPageToTop('smooth'); }}>
              <span>{item.icon}</span>
              <div><b>{item.title}</b><small>{item.desc}</small></div>
              {item.badge && <em>{item.badge}</em>}
            </button>
          ))}
        </nav>

        <div className="accountSidebarStatus">
          <span>✓</span>
          <div><b>Teacher access</b><small>Progress, reyting va speaking nazorati yoqilgan</small></div>
        </div>

        <button type="button" className="sidebarLogoutBtn accountSidebarLogout" onClick={() => safeLogout(onLogout)}>
          <span>↩</span>
          <div><b>Chiqish</b><small>Accountdan chiqish</small></div>
        </button>
      </aside>

      <section className="teacherWorkspace">
        <section className="teacherTopbar">
          <div>
            <span className="eyebrow miniEyebrow">O‘qituvchi paneli</span>
            <h1>{dashboard?.subjectTitle || 'Fan'} bo‘yicha nazorat</h1>
            <p>O‘zingizga biriktirilgan fan o‘quvchilari, progressi va past o‘zlashtirilgan mavzulari shu yerda.</p>
          </div>
          <label className="teacherSearchBox">
            <span>⌕</span>
            <input value={query} onChange={e => { setQuery(e.target.value); setTeacherTab('students'); }} placeholder="O‘quvchi qidirish..." />
          </label>
        </section>

        <section className="teacherMetricGrid">
          <div><span>O‘quvchi</span><b>{teacherStats.students || 0}</b><small>Biriktirilgan</small></div>
          <div><span>O‘rtacha</span><b>{teacherStats.avgProgress || 0}%</b><small>Umumiy progress</small></div>
          <div><span>Speaking</span><b>{teacherStats.avgSpeaking || 0}%</b><small>Talaffuz natijasi</small></div>
          <div><span>Active</span><b>{teacherStats.active || 0}</b><small>Faol account</small></div>
        </section>

        {message && <div className="alert info">{message}</div>}

        {teacherTab === 'overview' && (
          <section className="adminOpsGrid teacherOpsGrid">
            <div className="card opsCard"><div className="sectionHead"><h2>E’tibor kerak</h2></div><div className="attentionList">{(dashboard?.weak || []).map(u => <button className="attentionRow" key={u.id} onClick={() => openProgress(u.id)}><div><b>{u.fullName}</b><span>{u.currentLevel} · {u.currentTopicTitle}</span></div><strong>{u.progressPercent}%</strong></button>)}{!(dashboard?.weak || []).length && <p className="empty">E’tibor kerak bo‘lgan o‘quvchi yo‘q</p>}</div></div>
            <div className="card opsCard"><div className="sectionHead"><h2>Reyting</h2></div><div className="rankingList">{(dashboard?.ranking || []).map((u, i) => <button className="rankingRow" key={u.id} onClick={() => openProgress(u.id)}><b>#{i + 1}</b><div><strong>{u.fullName}</strong><span>{u.currentLevel} · joriy {u.currentTopicScore}%</span></div><em>{u.progressPercent}%</em></button>)}{!(dashboard?.ranking || []).length && <p className="empty">Reyting hali shakllanmagan</p>}</div></div>
          </section>
        )}

        {teacherTab === 'students' && (
          <section className="card teacherStudentsCard">
            <div className="sectionHead"><div><h2>O‘quvchilar</h2><p className="muted">Ism, login yoki daraja bo‘yicha qidiring.</p></div><b className="countBadge">{students.length} ta</b></div>
            <div className="table usersTable progressUsersTable">
              <div className="tr head"><b>Ism familya</b><b>Login</b><b>Daraja</b><b>Kelgan mavzu</b><b>Progress</b><b>Speaking</b><b>Status</b><b>Action</b></div>
              {students.map(u => <div className="tr" key={u.id}><span>{u.fullName}</span><span>{u.username}</span><span>{u.currentLevel}</span><span>{u.currentTopicTitle}</span><span>{u.progressPercent}%</span><span>{u.speakingPercent || 0}% · {u.speakingCheckedWords || 0}/{u.speakingTotalWords || 0} so‘z</span><span className={`status ${u.status}`}>{u.status}</span><span><button className="primary small" onClick={() => openProgress(u.id)}>Progress</button></span></div>)}
            </div>
          </section>
        )}

        {teacherTab === 'progress' && (
          selectedUser ? <section className="card studentProgressAdminCard"><div className="sectionHead"><div><h2>{selectedUser.fullName} progressi</h2><p className="muted">Har bir mavzu foizlari. Speaking ham alohida ko‘rinadi: qaysi o‘quvchi nechta so‘zni necha foiz aytyapti.</p></div><b className="countBadge">Speaking {selectedUser.speakingPercent || 0}%</b></div><div className="topicProgressGroups">{topicGroups.map(group => <div className={`topicProgressGroup ${!group.unlocked ? 'locked' : ''}`} key={group.level}><div className="topicGroupHead"><h3>{group.level}</h3><span>{group.unlocked ? `Yakuniy: ${group.finalBest || 0}%` : 'Yopiq'}</span></div><div className="topicProgressList">{group.topics.map(topic => <div className="topicProgressRow" key={`${group.level}-${topic.topicNo}`}><div className="topicProgressInfo"><b>{topic.topicNo}. {topic.title}</b><span>{topic.attempts || 0} urinish</span><small className="speakingTopicHint">🎤 Speaking: {topic.speakingScore || 0}% · {topic.speakingCheckedWords || 0}/{topic.speakingTotalWords || 30} so‘z</small></div><div className="miniPercent"><div style={{ width: `${Math.min(100, topic.bestScore || 0)}%` }} /></div><strong>{topic.bestScore || 0}%</strong></div>)}</div></div>)}</div></section>
          : <section className="card teacherEmptyProgress"><h2>Progress ko‘rish uchun o‘quvchi tanlang</h2><p className="muted">“O‘quvchilar” bo‘limidan kerakli o‘quvchini tanlab, Progress tugmasini bosing.</p><button className="primary" onClick={() => setTeacherTab('students')}>O‘quvchilar ro‘yxatiga o‘tish</button></section>
        )}
      </section>
    </main>
  );
}


function ChoiceCard({ title, subtitle, active, disabled, onClick }) {
  return (
    <button className={`choice ${active ? 'active' : ''}`} disabled={disabled} onClick={onClick}>
      <b>{title}</b>
      <span>{subtitle}</span>
      {disabled && <em>Yopiq</em>}
    </button>
  );
}

function TestView({ test, onSubmit, onCancel, submitText }) {
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const isMobile = useIsMobile(760);
  const questions = test.questions || [];
  const answeredCount = Object.keys(answers).length;

  useEffect(() => {
    scrollPageToTop('auto');
  }, []);

  useEffect(() => {
    if (isMobile) scrollPageToTop('smooth');
  }, [activeIndex, isMobile]);

  useEffect(() => {
    if (result) scrollPageToTop('smooth');
  }, [result]);

  function handleAnswer(q, optionIndex, index) {
    setAnswers(prev => ({ ...prev, [q.id]: optionIndex }));

    // Telefonda variant belgilangandan keyin avtomatik keyingi savolga o'tsin.
    // Masalan: 1-savolda javob belgilansa 2-savolga, keyin 3-savolga o'tadi.
    if (isMobile && index < questions.length - 1) {
      window.setTimeout(() => {
        setActiveIndex(index + 1);
      }, 350);
    }
  }

  async function submit() {
    setLoading(true);
    try {
      const data = await onSubmit(answers);
      setResult(data);
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (result) return <ResultBox result={result} onRetry={() => { setAnswers({}); setResult(null); setActiveIndex(0); }} onBack={onCancel} />;

  return (
    <section className="card testCard mobileFriendlyTestCard">
      <div className="sectionHead">
        <div><h2>{test.title}</h2><p>{test.description || 'Savollarga javob bering.'}</p></div>
        <button className="ghost" onClick={onCancel}>Orqaga</button>
      </div>
      <div className="progressLine"><span style={{ width: `${Math.round((answeredCount / Math.max(1, questions.length)) * 100)}%` }} /></div>
      <div className="testCounter">{answeredCount}/{questions.length} javob belgilandi</div>

      {isMobile ? (
        <MobileQuestionSwiper
          questions={questions}
          answers={answers}
          onAnswer={handleAnswer}
          activeIndex={activeIndex}
          setActiveIndex={setActiveIndex}
          title="Test"
        />
      ) : (
        questions.map((q, index) => (
          <QuestionBlock key={q.id} q={q} index={index} answer={answers[q.id]} onAnswer={handleAnswer} />
        ))
      )}

      <div className="stickyNext mobileTestFooter">
        <button className="primary big" onClick={submit} disabled={loading || answeredCount < questions.length}>{loading ? 'Tekshirilmoqda...' : submitText}</button>
        <button className="ghost" onClick={() => { setAnswers({}); setActiveIndex(0); }}>Tozalash</button>
      </div>
    </section>
  );
}

function WritingTestView({ topic, tasks = [], onSubmit, onCancel }) {
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeWritingIndex, setActiveWritingIndex] = useState(0);
  const isMobile = useIsMobile(760);
  const answeredCount = countCompletedWritingAnswers(tasks, answers);

  useEffect(() => {
    scrollPageToTop('auto');
  }, []);

  useEffect(() => {
    if (isMobile) scrollPageToTop('smooth');
  }, [activeWritingIndex, isMobile]);

  useEffect(() => {
    if (result) scrollPageToTop('smooth');
  }, [result]);

  function updateAnswer(id, value) {
    setAnswers(prev => ({ ...prev, [id]: value }));
  }

  async function submit() {
    setLoading(true);
    try {
      const data = await onSubmit(answers);
      setResult(data);
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (result) {
    return (
      <section className="card writingTestCard">
        <div className={`result ${result.passed ? 'pass' : 'fail'}`}>
          <div className="resultEmoji">{result.passed ? '✍️✅' : '✍️💪'}</div>
          <h2>{result.score}%</h2>
          <h3>{result.passed ? 'Yozma mashq yaxshi bajarildi' : 'Yozma javoblarni qayta mashq qiling'}</h3>
        </div>
        <WritingResultGroups details={result.details || []} startNumber={1} />
        <div className="actions center">
          <button className="primary" onClick={() => { setAnswers({}); setResult(null); }}>Qayta ishlash</button>
          <button className="ghost" onClick={onCancel}>Mavzuga qaytish</button>
        </div>
      </section>
    );
  }

  return (
    <section className="card testCard writingTestCard">
      <div className="sectionHead">
        <div>
          <h2>Yozma mashq</h2>
          <p>{topic.title} mavzusi bo‘yicha yozma topshiriqlarni bajaring.</p>
        </div>
        <button className="ghost" onClick={onCancel}>Orqaga</button>
      </div>
      <div className="progressLine"><span style={{ width: `${Math.round((answeredCount / Math.max(1, tasks.length)) * 100)}%` }} /></div>
      <div className="testCounter">{answeredCount}/{tasks.length} yozma javob kiritildi</div>
      {isMobile ? (
        <MobileWritingSwiper
          tasks={tasks}
          answers={answers}
          onAnswer={updateAnswer}
          activeIndex={activeWritingIndex}
          setActiveIndex={setActiveWritingIndex}
          onSubmit={submit}
          loading={loading}
        />
      ) : (
        <div className="writingTaskList">
          {tasks.map((task, index) => {
            const section = writingSectionLabel(task);
            const prevSection = index > 0 ? writingSectionLabel(tasks[index - 1]) : '';
            const helper = writingSectionHelperText(section);
            return (
              <React.Fragment key={task.id}>
                {(index === 0 || section !== prevSection) && <div className="writingSectionDivider"><b>{section}</b>{helper && <span>{helper}</span>}</div>}
                <div className="writingTask">
                  <div className="writingTaskTop">
                    <span>{index + 1}</span>
                    <div>
                      <h3>{task.title}</h3>
                      {shouldShowWritingTaskHint(task) && <p>{task.hint}</p>}
                    </div>
                  </div>
                  <WritingTaskAnswerArea
                    task={task}
                    value={answers[task.id] || ''}
                    onChange={value => updateAnswer(task.id, value)}
                  />
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}
      {!isMobile && (
        <div className="stickyNext">
          <button className="primary big" onClick={submit} disabled={loading}>{loading ? 'Tekshirilmoqda...' : 'Tekshirish'}</button>
          <button className="ghost" onClick={() => setAnswers({})}>Tozalash</button>
        </div>
      )}
    </section>
  );
}



function isNonLanguageSubject(topic) {
  return ['ona_tili', 'tarix'].includes(topic?.language);
}

function hasWritingPracticeForTopic(topic) {
  return Array.isArray(topic?.writingTasks) && topic.writingTasks.length > 0;
}

function hasSpeakingPracticeForTopic(topic) {
  return !isNonLanguageSubject(topic);
}

function hasVocabularyBlockForTopic(topic) {
  return !isNonLanguageSubject(topic);
}

function TopicPracticeView({ topic, onSubmit, onCancel, onNextTopic }) {
  const [stage, setStage] = useState('choice');
  const [choiceAnswers, setChoiceAnswers] = useState({});
  const [writingAnswers, setWritingAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeChoiceIndex, setActiveChoiceIndex] = useState(0);
  const [activeWritingIndex, setActiveWritingIndex] = useState(0);
  const isMobile = useIsMobile(760);

  const questions = topic.questions || [];
  const tasks = topic.writingTasks || [];
  const hasWriting = hasWritingPracticeForTopic(topic);
  const hasSentenceTasks = tasks.some(task => task.type === 'sentence_generation');
  const writingStageTitle = hasSentenceTasks ? 'So‘z yozish + gap tuzish' : 'So‘z yozish mashqi';
  const writingStageDescription = hasSentenceTasks
    ? '2-bosqich: avval inputli bo‘sh joy mashqlarini bajaring, keyin gap tuzish testlarini yozing. Katta/kichik harf farq qilmaydi: “IS WRITING” ham “is writing” kabi qabul qilinadi.'
    : '2-bosqich: faqat kerakli so‘z yoki grammatik shaklni yozing. Bu bosqichda gap tuzish ham, gap tarjima qilish ham yo‘q.';
  const choiceAnsweredCount = Object.keys(choiceAnswers).length;
  const writingAnsweredCount = countCompletedWritingAnswers(tasks, writingAnswers);

  useEffect(() => {
    scrollPageToTop('auto');
  }, []);

  useEffect(() => {
    scrollPageToTop('smooth');
  }, [stage]);

  // Mobile savol almashganda sahifa tepaga sakramasin.
  // Oldingi variantda activeChoiceIndex/activeWritingIndex o'zgarganda scrollPageToTop ishlardi,
  // telefonda javob belgilanganda test yangilanib tepaga chiqib ketayotgandek ko'rinardi.

  useEffect(() => {
    if (result) scrollPageToTop('smooth');
  }, [result]);

  function updateWritingAnswer(id, value) {
    setWritingAnswers(prev => ({ ...prev, [id]: value }));
  }

  function handleChoiceAnswer(q, optionIndex, index) {
    setChoiceAnswers(prev => ({ ...prev, [q.id]: optionIndex }));

    // Telefonda mashq variantini belgilasa keyingi raqamga avtomatik o'tadi:
    // 1 -> 2 -> 3 -> ... shu tarzda ketadi.
    if (isMobile && index < questions.length - 1) {
      window.setTimeout(() => {
        setActiveChoiceIndex(index + 1);
      }, 350);
    }
  }

  async function submitAll() {
    setLoading(true);
    try {
      const data = await onSubmit(topic, { choiceAnswers, writingAnswers });
      setResult(data);
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  function resetPractice() {
    setChoiceAnswers({});
    setWritingAnswers({});
    setResult(null);
    setStage('choice');
    setActiveChoiceIndex(0);
    setActiveWritingIndex(0);
  }

  if (result) {
    return (
      <section className="card writingTestCard practiceResultCard">
        <div className={`result ${result.passed ? 'pass' : 'fail'}`}>
          <div className="resultEmoji">{result.passed ? '🏆' : '💪'}</div>
          <h2>{result.score}%</h2>
          <h3>{result.passed ? 'Mashq bajarildi! Natija saqlandi' : 'Yana mashq qilish kerak'}</h3>
          <div className={`practiceScoreGrid ${hasWriting ? '' : 'twoColumns'}`}>
            <div><span>Tanlash mashqi</span><b>{result.choiceScore}%</b></div>
            {hasWriting && <div><span>Yozma mashq</span><b>{result.writingScore}%</b></div>}
            <div><span>Umumiy natija</span><b>{result.score}%</b></div>
          </div>
        </div>

        <PracticeResultCards
          choiceDetails={result.choice?.details || []}
          writingDetails={result.writing?.details || []}
          hasWriting={hasWriting}
        />

        <div className="actions center">
          <button className="primary" onClick={resetPractice}>Qayta bajarish</button>
          {result.passed && <button className="primary altPrimary" onClick={() => onNextTopic(topic)}>Keyingi mavzuga o‘tish →</button>}
          <button className="ghost" onClick={onCancel}>Mavzularga qaytish</button>
        </div>
      </section>
    );
  }

  if (stage === 'choice') {
    return (
      <section className="card testCard practiceCard">
        <div className="sectionHead">
          <div>
            <h2>Mashq bajarish</h2>
            <p>{hasWriting ? `1-bosqich: ${topic.title} mavzusi bo‘yicha ${questions.length} ta tanlanadigan test. Keyingi bosqichda ${hasSentenceTasks ? 'so‘z yozish va gap tuzish mashqlari' : 'faqat so‘z yozish mashqlari'} bor.` : `${topic.title} mavzusi bo‘yicha ${questions.length} ta tanlash mashqi. Natija saqlanadi.`}</p>
          </div>
          <button className="ghost" onClick={onCancel}>Orqaga</button>
        </div>
        <div className="practiceStageTabs">
          <b className="active">{hasWriting ? '10 ta tanlanadigan test' : 'Tanlash mashqi'}</b>
          {hasWriting && <b>{writingStageTitle}</b>}
          <span>{hasWriting ? (hasSentenceTasks ? '3 bosqichli mashq birga hisoblanadi' : 'Tanlash + so‘z yozish natijasi birga hisoblanadi') : 'Test natijasi saqlanadi'}</span>
        </div>
        <div className="progressLine"><span style={{ width: `${Math.round((choiceAnsweredCount / Math.max(1, questions.length)) * 100)}%` }} /></div>
        <div className="testCounter">{choiceAnsweredCount}/{questions.length} javob belgilandi</div>
        {isMobile ? (
          <MobileQuestionSwiper
            questions={questions}
            answers={choiceAnswers}
            onAnswer={handleChoiceAnswer}
            activeIndex={activeChoiceIndex}
            setActiveIndex={setActiveChoiceIndex}
            title="Mashq"
          />
        ) : (
          questions.map((q, index) => (
            <QuestionBlock key={q.id} q={q} index={index} answer={choiceAnswers[q.id]} onAnswer={handleChoiceAnswer} />
          ))
        )}
        <div className="stickyNext">
          <button className="primary big" onClick={hasWriting ? () => { setStage('writing'); scrollPageToTop('smooth'); } : submitAll} disabled={loading || choiceAnsweredCount < questions.length}>{hasWriting ? 'Keyingi mashq: yozma topshiriq →' : loading ? 'Tekshirilmoqda...' : 'Mashqni yakunlash'}</button>
          <button className="ghost" onClick={() => { setChoiceAnswers({}); setActiveChoiceIndex(0); }}>Tozalash</button>
        </div>
      </section>
    );
  }

  if (!hasWriting) return null;

  return (
    <section className="card testCard writingTestCard practiceCard">
      <div className="sectionHead">
        <div>
          <h2>Mashq bajarish</h2>
          <p>{writingStageDescription}</p>
        </div>
        <button className="ghost" onClick={() => { setStage('choice'); scrollPageToTop('smooth'); }}>← Oldingi mashq</button>
      </div>
      <div className="practiceStageTabs">
        <b>10 ta tanlanadigan test</b>
        <b className="active">{writingStageTitle}</b>
        <span>Natijalar birlashtirilib umumiy ball chiqadi</span>
      </div>
      <div className="progressLine"><span style={{ width: `${Math.round((writingAnsweredCount / Math.max(1, tasks.length)) * 100)}%` }} /></div>
      <div className="testCounter">{writingAnsweredCount}/{tasks.length} yozma javob kiritildi</div>
      {isMobile ? (
        <MobileWritingSwiper
          tasks={tasks}
          answers={writingAnswers}
          onAnswer={updateWritingAnswer}
          activeIndex={activeWritingIndex}
          setActiveIndex={setActiveWritingIndex}
          onSubmit={submitAll}
          loading={loading}
        />
      ) : (
        <div className="writingTaskList">
          {tasks.map((task, index) => {
            const section = writingSectionLabel(task);
            const prevSection = index > 0 ? writingSectionLabel(tasks[index - 1]) : '';
            const helper = writingSectionHelperText(section);
            return (
              <React.Fragment key={task.id}>
                {(index === 0 || section !== prevSection) && <div className="writingSectionDivider"><b>{section}</b>{helper && <span>{helper}</span>}</div>}
                <div className="writingTask">
                  <div className="writingTaskTop">
                    <span>{index + 1}</span>
                    <div>
                      <h3>{task.title}</h3>
                      {shouldShowWritingTaskHint(task) && <p>{task.hint}</p>}
                    </div>
                  </div>
                  <WritingTaskAnswerArea
                    task={task}
                    value={writingAnswers[task.id] || ''}
                    onChange={value => updateWritingAnswer(task.id, value)}
                  />
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}
      {!isMobile && (
        <div className="stickyNext">
          <button className="primary big" onClick={submitAll} disabled={loading || writingAnsweredCount < tasks.length}>{loading ? 'Tekshirilmoqda...' : 'Mashqni yakunlash'}</button>
          <button className="ghost" onClick={() => setWritingAnswers({})}>Tozalash</button>
        </div>
      )}
    </section>
  );
}

function ResultBox({ result, onRetry, onBack }) {
  const passText = result.passed ? 'Tabriklaymiz! Keyingi bosqich ochildi' : 'Qayta tayyorlanish kerak';
  return (
    <section className="card resultReviewCard">
      <div className={`result ${result.passed ? 'pass' : 'fail'}`}>
        <div className="resultEmoji">{result.passed ? '🏆' : '💪'}</div>
        <h2>{result.score}%</h2>
        <h3>{passText}</h3>
        <p>{result.feedback}</p>
        {result.certificate && <div className="resultCertificateNotice">🏅 Sertifikat foizi: <b>{result.certificate.score}%</b> · {result.certificate.rank || 'Daraja testi yakunlandi'}</div>}
      </div>
      <div className="resultExerciseGrid">
        <ResultExerciseCard
          title="Test savollari"
          subtitle="Har bir savol alohida cardda tekshiruv natijasi bilan ko‘rinadi."
          details={result.details || []}
          kind="choice"
        />
      </div>
      <div className="actions center">
        <button className="primary" onClick={onRetry}>Qayta ishlash</button>
        {onBack && <button className="ghost" onClick={onBack}>Orqaga qaytish</button>}
      </div>
    </section>
  );
}

function getSpeechLang(language) {
  if (language === 'russia') return 'ru-RU';
  if (language === 'koreys') return 'ko-KR';
  if (language === 'ona_tili' || language === 'tarix') return 'uz-UZ';
  return 'en-US';
}

function normalizeSpeechText(value = '') {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarityScore(expected, spoken) {
  const a = normalizeSpeechText(expected);
  const b = normalizeSpeechText(spoken);
  if (!a || !b) return 0;
  if (a === b || b.includes(a)) return 100;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  const distance = rows[a.length][b.length];
  return Math.max(0, Math.round((1 - distance / Math.max(a.length, b.length)) * 100));
}

function cleanSentence(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function splitLearningExample(example = '') {
  const parts = String(example).split(' / ');
  return { main: cleanSentence(parts[0] || example), translation: cleanSentence(parts.slice(1).join(' / ')) };
}

function isToBeTopic(topic) {
  return String(topic.title || '').toLowerCase().includes('to be');
}


function normalizeLessonTitle(value = '') {
  return String(value || '').toUpperCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}

const cleanWorkbookTopics = new Set([
  'A / AN',
  'PLURALS (REGULAR)',
  'PLURAL (IRREGULAR)',
  'SUBJECT PRONOUN',
  'TO BE',
  'THERE IS / THERE ARE',
  'HAVE / HAS',
  'CAN / CAN\'T',
  'WHO / WHAT',
  'PREPOSITION OF PLACE',
  'PREPOSITION OF TIME',
  'COMPARATIVE ADJECTIVES',
  'PRESENT CONTINUOUS',
  'PRESENT SIMPLE',
  'PRESENT SIMPLE & PRESENT CONTINUOUS',
  'PAST SIMPLE',
  'PAST CONTINUOUS',
  'FUTURE SIMPLE / TO BE GOING TO',
  'PRESENT PERFECT',
  'PRESENT PERFECT INTRO',
  'COMPARATIVE ADJECTIVES'
]);

function isCleanWorkbookTopic(topic) {
  return topic?.language === 'english' && cleanWorkbookTopics.has(normalizeLessonTitle(topic?.title));
}


const topicKeyWordsByTitle = {
  'A / AN': [
    ['a', 'undosh tovushdan oldin: a dog'],
    ['an', 'unli tovushdan oldin: an apple'],
    ['singular noun', 'birlik ot: a book'],
    ['countable noun', 'sanasa bo‘ladigan ot'],
    ['vowel sound', 'unli tovush: an egg'],
    ['consonant sound', 'undosh tovush: a pen'],
    ['a/an kerak emas', 'ko‘plik/sanalmaydigan otlarda']
  ],
  'PLURALS (REGULAR)': [
    ['singular', 'birlik'], ['plural', 'ko‘plik'], ['-s', 'oddiy ko‘plik qo‘shimchasi'], ['-es', 's, x, ch, sh bilan tugagan so‘zlarga'], ['one', 'bitta'], ['many', 'ko‘p']
  ],
  'PLURAL (IRREGULAR)': [
    ['irregular plural', 'qoidaga bo‘ysunmaydigan ko‘plik'], ['child → children', 'bola → bolalar'], ['man → men', 'erkak → erkaklar'], ['woman → women', 'ayol → ayollar'], ['person → people', 'odam → odamlar']
  ],
  'TO BE': [
    ['am', 'I bilan: I am'],
    ['is', 'he/she/it yoki birlik ot bilan'],
    ['are', 'you/we/they yoki ko‘plik ot bilan'],
    ['not', 'emas / inkor shakli'],
    ['subject', 'ega — gap kim/nima haqida'],
    ['adjective', 'sifat: happy, tired, cold'],
    ['noun', 'ot: student, teacher, book'],
    ['short answer', 'qisqa javob: Yes, I am.'],
    ['contraction', 'qisqa shakl: I’m, he’s, aren’t']
  ],
  'SUBJECT PRONOUN': [
    ['I', 'men'], ['you', 'sen / siz'], ['he', 'u — erkak'], ['she', 'u — ayol'], ['it', 'u — narsa/hayvon'], ['we', 'biz'], ['they', 'ular']
  ],
  'THERE IS / THERE ARE': [
    ['there is', 'bor — bitta narsa uchun'], ['there are', 'bor — ko‘plik uchun'], ['there isn’t', 'yo‘q — bitta narsa uchun'], ['there aren’t', 'yo‘q — ko‘plik uchun'], ['any', 'savol/inkorda “hech qanday / biror”'], ['near', 'yaqinida']
  ],
  'HAVE / HAS': [
    ['have', 'I / you / we / they bilan ishlatiladi'], ['has', 'he / she / it yoki bitta ism bilan ishlatiladi'], ['I have', 'menda bor'], ['She has', 'unda bor'], ['They have', 'ularda bor'], ['Ali has', 'Alida bor']
  ],
  'CAN / CAN’T': [
    ['can', 'qila olmoq'], ["can’t", 'qila olmaslik'], ['ability', 'qobiliyat'], ['permission', 'ruxsat'], ['Can you...?', 'Siz ... qila olasizmi?']
  ],
  'WHO / WHAT': [
    ['who', 'kim'], ['what', 'nima'], ['question word', 'savol so‘zi'], ['answer', 'javob'], ['person', 'odam'], ['thing', 'narsa']
  ],
  'PRESENT CONTINUOUS': [
    ['now', 'hozir — ayni paytda bo‘layotgan ish'],
    ['right now', 'aynan hozir'],
    ['at the moment', 'ayni paytda'],
    ['today', 'bugun — vaqtinchalik holat'],
    ['this week', 'shu hafta davomida'],
    ['these days', 'shu kunlarda'],
    ['Look!', 'Qara! hozir bo‘layotgan ish'],
    ['Listen!', 'Eshit! hozir bo‘layotgan ish'],
    ['am/is/are', 'to be yordamchi fe’llari'],
    ['verb-ing', '-yapti / -moqda shakli'],
    ['not', 'inkor yasaydi'],
    ['always', 'doim — ba’zan shikoyat ma’nosida']
  ],
  'PRESENT SIMPLE': [
    ['every day', 'har kuni — odat yoki takroriy ish'],
    ['usually', 'odatda'],
    ['always', 'har doim'],
    ['often', 'tez-tez'],
    ['sometimes', 'ba’zan'],
    ['never', 'hech qachon'],
    ['do', 'I/you/we/they bilan savol va inkorda'],
    ['does', 'he/she/it bilan savol va inkorda'],
    ['V1', 'asosiy fe’l shakli'],
    ['-s / -es', 'he/she/it bilan darak gapda']
  ],
  'PRESENT SIMPLE & PRESENT CONTINUOUS': [
    ['usually', 'odatda — Present Simple belgisi'], ['now', 'hozir — Present Continuous belgisi'], ['every day', 'har kuni'], ['at the moment', 'ayni paytda'], ['habit', 'odat'], ['temporary', 'vaqtincha']
  ],
  'PREPOSITION OF PLACE': [
    ['in', 'ichida'], ['on', 'ustida'], ['under', 'ostida'], ['next to', 'yonida'], ['between', 'orasida'], ['behind', 'orqasida'], ['in front of', 'oldida']
  ],
  'PREPOSITION OF TIME': [
    ['at', 'aniq vaqt: at 9 o’clock / at night'], ['on', 'kun yoki sana: on Monday / on 15 May'], ['in', 'oy, yil, fasl yoki kun qismi: in May / in 2026 / in summer']
  ],
  'COMPARATIVE ADJECTIVES': [
    ['tall', 'baland'], ['short', 'past / kalta'], ['big', 'katta'], ['small', 'kichik'], ['long', 'uzun'], ['fast', 'tez'], ['slow', 'sekin'], ['hot', 'issiq'], ['cold', 'sovuq'], ['young', 'yosh'], ['old', 'qari / eski'], ['easy', 'oson'], ['difficult', 'qiyin'], ['happy', 'xursand'], ['sad', 'xafa'], ['beautiful', 'chiroyli'], ['expensive', 'qimmat'], ['cheap', 'arzon'], ['strong', 'kuchli'], ['weak', 'kuchsiz'], ['good', 'yaxshi'], ['bad', 'yomon'], ['rich', 'boy'], ['poor', 'kambag‘al'], ['clean', 'toza'], ['dirty', 'kir'], ['high', 'baland'], ['low', 'past'], ['heavy', 'og‘ir'], ['light', 'yengil']
  ],
  'ADVERB AND ADJECTIVE': [
    ['adjective', 'sifat — qanday?'], ['adverb', 'ravish — qanday qilib?'], ['quick', 'tez — sifat'], ['quickly', 'tezda — ravish'], ['good', 'yaxshi'], ['well', 'yaxshi tarzda']
  ],
  'PREPOSITION TIME AND PLACE': [
    ['at', 'aniq joy/vaqt'], ['on', 'ustida yoki kun'], ['in', 'ichida yoki oy/yil'], ['place', 'joy'], ['time', 'vaqt'], ['near', 'yaqinida']
  ],
  'PAST SIMPLE': [
    ['yesterday', 'kecha'], ['last week', 'o‘tgan hafta'], ['ago', 'oldin'], ['did', 'savol/inkorda yordamchi fe’l'], ['V2', 'fe’lning 2-shakli'], ['regular verb', 'to‘g‘ri fe’l'], ['irregular verb', 'noto‘g‘ri fe’l']
  ],
  'PAST CONTINUOUS': [
    ['was', 'I/he/she/it bilan'], ['were', 'you/we/they bilan'], ['verb-ing', 'davom etayotgan harakat'], ['at 8 o’clock', 'soat 8 da'], ['while', '... paytida'], ['when', '... bo‘lganda']
  ],
  'FUTURE SIMPLE / TO BE GOING TO': [
    ['will', 'kelajakda qiladi'], ['going to', 'reja qilgan / niyat'], ['tomorrow', 'ertaga'], ['next week', 'keyingi hafta'], ['later', 'keyinroq'], ['promise', 'va’da']
  ],
  'PRESENT PERFECT': [
    ['have/has', 'Present Perfect yordamchi fe’li'], ['V3', 'fe’lning 3-shakli'], ['already', 'allaqachon'], ['yet', 'hali / hali ham'], ['ever', 'hech qachon?'], ['never', 'hech qachon'], ['just', 'hozirgina']
  ],
  'PRESENT PERFECT INTRO': [
    ['have/has', 'Present Perfect yordamchi fe’li'], ['V3', 'fe’lning 3-shakli'], ['already', 'allaqachon'], ['yet', 'hali'], ['ever', 'hech qachon?'], ['never', 'hech qachon']
  ],
  'CONDITIONAL 0': [
    ['if', 'agar'], ['when', 'qachonki'], ['always true', 'doim to‘g‘ri holat'], ['result', 'natija'], ['Present Simple', 'hozirgi oddiy zamon']
  ],
  'CONDITIONAL 1': [
    ['if', 'agar'], ['will', 'kelajak natija'], ['possible', 'bo‘lishi mumkin'], ['condition', 'shart'], ['result', 'natija']
  ],
  'HAVE TO / MUST': [
    ['must', 'shart / majbur'], ['have to', 'majbur bo‘lmoq'], ['don’t have to', 'shart emas'], ['mustn’t', 'mumkin emas'], ['rule', 'qoida']
  ],
  'WOULD / COULD': [
    ['would', 'xohish / odobli so‘rov'], ['could', 'qila olardi / iltimos'], ['polite request', 'odobli iltimos'], ['possibility', 'imkoniyat'], ['past ability', 'o‘tmishdagi qobiliyat']
  ],
  'USED TO': [
    ['used to', 'oldin odat bo‘lgan'], ['didn’t use to', 'oldin odat bo‘lmagan'], ['Did you use to...?', 'Oldin ... qilarmidingiz?'], ['past habit', 'o‘tmishdagi odat'], ['now', 'hozir']
  ],
  'USED TO / WOULD': [
    ['used to', 'oldingi odat/holat'], ['would', 'oldingi takroriy harakat'], ['past habit', 'o‘tmishdagi odat'], ['state', 'holat'], ['action', 'harakat']
  ],
  'GERUND INFINITIVE': [
    ['gerund', 'verb + ing'], ['infinitive', 'to + verb'], ['enjoy doing', 'qilishdan zavqlanmoq'], ['want to do', 'qilmoqchi bo‘lmoq'], ['after prepositions', 'predloglardan keyin']
  ],
  'ARTICLES: A/AN/THE': [
    ['a/an', 'bitta/noaniq'], ['the', 'aniq artikl'], ['first time', 'birinchi marta aytilganda'], ['second time', 'yana aytilganda'], ['specific', 'aniq']
  ],
  'PLURAL NOUNS': [
    ['singular', 'birlik'], ['plural', 'ko‘plik'], ['regular plural', 'qoidali ko‘plik'], ['irregular plural', 'qoidaga bo‘ysunmaydigan ko‘plik'], ['many', 'ko‘p']
  ],
  'THIS, THAT, THESE, THOSE': [
    ['this', 'bu — yaqin, birlik'], ['that', 'ana u — uzoq, birlik'], ['these', 'bular — yaqin, ko‘plik'], ['those', 'anavilar — uzoq, ko‘plik'], ['near', 'yaqin'], ['far', 'uzoq']
  ],
  'POSSESSIVE ADJECTIVES': [
    ['my', 'mening'], ['your', 'sening/sizning'], ['his', 'uning — erkak'], ['her', 'uning — ayol'], ['our', 'bizning'], ['their', 'ularning']
  ],
  'QUESTION WORDS': [
    ['what', 'nima'], ['where', 'qayerda'], ['when', 'qachon'], ['why', 'nima uchun'], ['who', 'kim'], ['how', 'qanday']
  ],
  'ADVERBS OF FREQUENCY': [
    ['always', 'har doim'], ['usually', 'odatda'], ['often', 'tez-tez'], ['sometimes', 'ba’zan'], ['rarely', 'kamdan-kam'], ['never', 'hech qachon']
  ],
  'COUNTABLE / UNCOUNTABLE NOUNS': [
    ['countable', 'sanasa bo‘ladigan'], ['uncountable', 'sanab bo‘lmaydigan'], ['some', 'bir oz / bir nechta'], ['any', 'biror / hech qanday'], ['much', 'ko‘p — uncountable'], ['many', 'ko‘p — countable']
  ],
  'PAST SIMPLE INTRO': [
    ['yesterday', 'kecha'], ['last night', 'kecha kechqurun'], ['did', 'savol/inkor yordamchi fe’li'], ['was/were', 'to be o‘tgan zamon'], ['V2', 'fe’lning 2-shakli']
  ],
  'PAST SIMPLE REGULAR VERBS': [
    ['-ed', 'regular fe’l qo‘shimchasi'], ['played', 'o‘ynadi'], ['watched', 'tomosha qildi'], ['started', 'boshladi'], ['did not', 'qilmadi']
  ],
  'PAST SIMPLE IRREGULAR VERBS': [
    ['went', 'bordi'], ['saw', 'ko‘rdi'], ['came', 'keldi'], ['had', 'bor edi / ega edi'], ['did', 'qildi']
  ],
  'FUTURE WITH GOING TO': [
    ['going to', 'reja qilgan'], ['plan', 'reja'], ['soon', 'tez orada'], ['tomorrow', 'ertaga'], ['next', 'keyingi']
  ],
  'COMPARATIVES': [
    ['bigger', 'kattaroq'], ['smaller', 'kichikroq'], ['more interesting', 'qiziqroq'], ['than', '...dan ko‘ra'], ['better', 'yaxshiroq']
  ],
  'SUPERLATIVES': [
    ['the biggest', 'eng katta'], ['the best', 'eng yaxshi'], ['the most interesting', 'eng qiziqarli'], ['in the class', 'sinfda'], ['of all', 'hammasidan']
  ],
  'MODAL SHOULD': [
    ['should', 'kerak / maslahat'], ['shouldn’t', 'kerak emas'], ['advice', 'maslahat'], ['You should...', 'Siz ... qilishingiz kerak'], ['What should I do?', 'Men nima qilishim kerak?']
  ],
  'SOME / ANY': [
    ['some', 'bir oz / bir nechta'], ['any', 'biror / hech qanday'], ['positive', 'darak gap'], ['negative', 'inkor gap'], ['question', 'so‘roq gap']
  ],
  'MUCH / MANY': [
    ['much', 'ko‘p — sanalmaydigan'], ['many', 'ko‘p — sanaladigan'], ['a lot of', 'juda ko‘p'], ['How much?', 'qancha?'], ['How many?', 'nechta?']
  ],
  'ADVERBS OF MANNER': [
    ['slowly', 'sekin'], ['quickly', 'tezda'], ['carefully', 'ehtiyotkorlik bilan'], ['well', 'yaxshi'], ['badly', 'yomon']
  ],
  'OBJECT PRONOUNS': [
    ['me', 'meni / menga'], ['you', 'seni / sizni'], ['him', 'uni — erkak'], ['her', 'uni — ayol'], ['us', 'bizni / bizga'], ['them', 'ularni / ularga']
  ],
  'GERUND BASICS': [
    ['doing', 'qilish'], ['playing', 'o‘ynash'], ['after like', 'like dan keyin'], ['after enjoy', 'enjoy dan keyin'], ['verb-ing', 'fe’l + ing']
  ],
  'FIRST CONDITIONAL': [
    ['if', 'agar'], ['will', 'kelajak natija'], ['possible future', 'bo‘lishi mumkin kelajak'], ['condition', 'shart'], ['result', 'natija']
  ],
  'SECOND CONDITIONAL': [
    ['if', 'agar'], ['would', 'bo‘lardi'], ['imaginary', 'tasavvuriy'], ['were', 'hamma ega bilan ishlatilishi mumkin'], ['If I were...', 'Agar men ... bo‘lganimda']
  ],
  'PASSIVE VOICE INTRO': [
    ['passive', 'majhul nisbat'], ['be + V3', 'passive shakli'], ['by', 'tomonidan'], ['is made', 'tayyorlanadi'], ['was built', 'qurilgan']
  ],
  'RELATIVE CLAUSES': [
    ['who', 'odam uchun'], ['which', 'narsa/hayvon uchun'], ['that', 'odam/narsa uchun'], ['where', 'joy uchun'], ['relative clause', 'aniqlovchi gap']
  ],
  'REPORTED SPEECH INTRO': [
    ['said', 'aytdi'], ['told', 'aytdi / dedi'], ['reported speech', 'ko‘chirma gap emas, aytilgan gap'], ['backshift', 'zamon orqaga siljishi'], ['that', 'deb']
  ],
  'MODAL VERBS': [
    ['can', 'qila olmoq'], ['must', 'shart'], ['should', 'kerak / maslahat'], ['may', 'mumkin'], ['might', 'ehtimol']
  ]
};

const tenseKeywordTopics = new Set([
  'PRESENT CONTINUOUS',
  'PRESENT SIMPLE',
  'PRESENT SIMPLE & PRESENT CONTINUOUS',
  'PAST SIMPLE',
  'PAST CONTINUOUS',
  'FUTURE SIMPLE / TO BE GOING TO',
  'FUTURE WITH GOING TO',
  'PRESENT PERFECT',
  'PRESENT PERFECT INTRO',
  'PAST SIMPLE REGULAR VERBS',
  'PAST SIMPLE IRREGULAR VERBS'
]);

function isTenseKeywordTopic(topic) {
  const title = normalizeLessonTitle(topic?.title);
  return tenseKeywordTopics.has(title) || /\b(PRESENT|PAST|FUTURE)\b/.test(title);
}

function getTopicKeyWords(topic) {
  if (topic?.language !== 'english') return [];
  const title = normalizeLessonTitle(topic?.title);
  if (!isTenseKeywordTopic(topic)) return [];
  const direct = topicKeyWordsByTitle[title];
  if (direct?.length) return direct.map(([word, meaning]) => ({ word, meaning }));
  const words = [];
  const source = `${topic?.title || ''} ${(topic?.examples || []).slice(0, 2).join(' ')}`.toLowerCase();
  if (source.includes('present')) words.push(['present', 'hozirgi zamon']);
  if (source.includes('past')) words.push(['past', 'o‘tgan zamon']);
  if (source.includes('future')) words.push(['future', 'kelasi zamon']);
  if (source.includes('question')) words.push(['question', 'savol']);
  if (source.includes('will')) words.push(['will', 'kelasi zamon yordamchisi']);
  if (source.includes('have') || source.includes('has')) words.push(['have/has', 'Perfect zamon yordamchisi']);
  if (source.includes('was') || source.includes('were')) words.push(['was/were', 'o‘tgan zamon to be shakli']);
  return words.slice(0, 6).map(([word, meaning]) => ({ word, meaning }));
}


function splitFormulaLines(value = '') {
  const text = String(value || '').trim();
  if (!text) return [];
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n+|\.\s+|;\s*/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/\.$/, '').trim());
}


function getCleanTopicFormCards(topic) {
  const title = normalizeLessonTitle(topic?.title);
  // ULUGBEK_CUSTOM_BEGINNER_CARDS_V1
  const upgradedCards = {
    "PLURALS (REGULAR)": [
        {
            "icon": "🌱",
            "title": "Birlikdan ko‘plikka o‘tish",
            "formula": "singular = one thing\nplural = two or more things",
            "text": "Bitta narsa singular, ikki yoki undan ko‘p narsa plural bo‘ladi. Ingliz tilida son 2 yoki undan katta bo‘lsa, ot ham ko‘plik shaklida keladi.",
            "points": [
                "one book — bitta kitob",
                "two books — ikkita kitob",
                "two book deyish xato, chunki two ko‘plik talab qiladi."
            ],
            "examples": [
                "one book — two books / bitta kitob — ikkita kitob",
                "one pen — five pens / bitta ruchka — beshta ruchka",
                "The students are here. / O‘quvchilar shu yerda."
            ]
        },
        {
            "icon": "➕",
            "title": "-s va -es qoidasi",
            "formula": "Oddiy otlarda -s\ns / ss / sh / ch / x / o oxirida -es",
            "text": "Agar so‘z oxiri oddiy bo‘lsa -s qo‘shiladi. Agar oxiri talaffuzda “shovqinli” tovushlar bilan tugasa, aytish oson bo‘lishi uchun -es qo‘shiladi.",
            "points": [
                "cars va books — ko‘plik shakllari",
                "buses va boxes — -es bilan yoziladi",
                "watches va classes — -es bilan yoziladi"
            ],
            "examples": [
                "one car — two cars / bitta mashina — ikkita mashina",
                "one bus — two buses / bitta avtobus — ikkita avtobus",
                "one box — three boxes / bitta quti — uchta quti"
            ]
        },
        {
            "icon": "🔁",
            "title": "Y bilan tugagan so‘zlar",
            "formula": "Undosh + y oxirida -ies\nUnli + y oxirida -s",
            "text": "Y dan oldingi harfga qarang. Agar undosh bo‘lsa y tushadi va -ies keladi. Agar unli bo‘lsa y qoladi va faqat -s qo‘shiladi.",
            "points": [
                "babies va cities — -ies bilan yoziladi",
                "boys va toys — y qolib, -s keladi",
                "keys — y qolib, -s keladi"
            ],
            "examples": [
                "one baby — two babies / bitta chaqaloq — ikkita chaqaloq",
                "one city — three cities / bitta shahar — uchta shahar",
                "one boy — two boys / bitta bola — ikkita bola"
            ]
        },
        {
            "icon": "🚫",
            "title": "Eng ko‘p xato qilinadigan joy",
            "formula": "a/an + singular only\nno a/an + plural\nmany/these/those + plural",
            "text": "A/an faqat bitta narsa bilan ishlatiladi. Ko‘plikda a/an qo‘yilmaydi. Many, these, those so‘zlaridan keyin ot ko‘plik bo‘ladi.",
            "points": [
                "a book — to‘g‘ri",
                "a books — xato",
                "many students — to‘g‘ri"
            ],
            "examples": [
                "I have two books. / Menda ikkita kitob bor.",
                "These apples are fresh. / Bu olmalar yangi.",
                "Many students are in class. / Sinfda ko‘p o‘quvchilar bor."
            ]
        }
    ],
    "PLURAL (IRREGULAR)": [
        {
            "icon": "🧩",
            "title": "Irregular plural nima?",
            "formula": "irregular plural = special plural form",
            "text": "Bu so‘zlar oddiy -s qoidasiga kirmaydi. Ularni maxsus shaklda yodlaymiz: child → children, man → men, person → people.",
            "points": [
                "childs emas — children",
                "mans emas — men",
                "persons oddiy suhbatda ko‘pincha people bo‘ladi."
            ],
            "examples": [
                "one child — two children / bitta bola — ikkita bola",
                "one man — three men / bitta erkak — uchta erkak",
                "one person — many people / bitta odam — ko‘p odamlar"
            ]
        },
        {
            "icon": "👨‍👩‍👧",
            "title": "Odamlar bilan ishlatiladigan shakllar",
            "formula": "children, men, women, people — maxsus ko‘plik shakllari",
            "text": "Eng ko‘p uchraydigan irregular plurallar odamlar haqida gapirganda kerak bo‘ladi. Ularning o‘zi ko‘plik ma’nosini beradi, yana -s qo‘shilmaydi.",
            "points": [
                "children = bolalar, childrens emas",
                "women = ayollar, womans emas",
                "people = odamlar, peoples emas"
            ],
            "examples": [
                "The children are playing. / Bolalar o‘ynayapti.",
                "The women are teachers. / Ayollar ustozlar.",
                "Many people are here. / Bu yerda ko‘p odamlar bor."
            ]
        },
        {
            "icon": "🦷",
            "title": "Tana a’zolari va hayvonlar",
            "formula": "teeth, feet, mice, geese — maxsus ko‘plik shakllari",
            "text": "Ba’zi kundalik so‘zlarning ichki tovushi o‘zgaradi. Shuning uchun ularni juftlik qilib aytish eng oson: one tooth, two teeth.",
            "points": [
                "feet — foot so‘zining maxsus ko‘plik shakli",
                "teeth — tooth so‘zining maxsus ko‘plik shakli",
                "mice — mouse so‘zining maxsus ko‘plik shakli"
            ],
            "examples": [
                "My feet are cold. / Oyoqlarim sovuq.",
                "Brush your teeth. / Tishlaringizni yuving.",
                "There are two mice. / Ikkita sichqon bor."
            ]
        },
        {
            "icon": "🐑",
            "title": "Shakli o‘zgarmaydigan so‘zlar",
            "formula": "sheep va fish ko‘pincha birlik/ko‘plikda bir xil",
            "text": "Ayrim otlar birlikda ham, ko‘plikda ham bir xil ko‘rinadi. Son yoki kontekst ularning nechta ekanini bildiradi.",
            "points": [
                "one sheep — bitta qo‘y",
                "ten sheep — o‘nta qo‘y",
                "fish ko‘pincha birlik/ko‘plikda bir xil ishlatiladi."
            ],
            "examples": [
                "There is one sheep. / Bitta qo‘y bor.",
                "There are ten sheep. / O‘nta qo‘y bor.",
                "I can see two fish. / Men ikkita baliq ko‘ryapman."
            ]
        }
    ],
    "TO BE": [
        {
            "icon": "🧠",
            "title": "To be nima vazifa bajaradi?",
            "formula": "to be = am / is / are\nwho? how?",
            "text": "To be gapda odamning kim ekanini yoki qanday holatda ekanini bildiradi. O‘zbekchada ko‘pincha alohida ko‘rinmaydi, lekin inglizchada gapni to‘liq qilish uchun kerak.",
            "points": [
                "Men o‘quvchiman → I am a student.",
                "Ular tayyor → They are ready."
            ],
            "examples": [
                "I am a student. / Men o‘quvchiman.",
                "They are happy. / Ular xursand."
            ]
        },
        {
            "icon": "✅",
            "title": "Darak gap",
            "formula": "I am ...\nHe / She / It is ...\nYou / We / They are ...",
            "text": "Darak gapda avval ega keladi, keyin egaga mos am/is/are qo‘yiladi. Bu gap oddiy xabar beradi.",
            "points": [
                "I bilan am",
                "He/She/It bilan is",
                "You/We/They bilan are"
            ],
            "examples": [
                "I am ready. / Men tayyorman.",
                "He is a doctor. / U shifokor.",
                "We are in class. / Biz darsdamiz."
            ]
        },
        {
            "icon": "➖",
            "title": "Inkor gap",
            "formula": "subject + am/is/are + not",
            "text": "Inkor gapda “emas” ma’nosi beriladi. Buning uchun am/is/are dan keyin not qo‘yiladi.",
            "points": [
                "I am not = men ... emasman",
                "is not = isn’t",
                "are not = aren’t"
            ],
            "examples": [
                "I am not tired. / Men charchagan emasman.",
                "She is not busy. / U band emas.",
                "They are not late. / Ular kechikkan emas."
            ]
        },
        {
            "icon": "❓",
            "title": "Savol gap",
            "formula": "Am / Is / Are + subject + ...?",
            "text": "Savolda am/is/are gap boshiga chiqadi. Javobda ham shu fe’l bilan qisqa javob beriladi.",
            "points": [
                "Are you ready? — Yes, I am.",
                "Is she your teacher? — No, she isn’t.",
                "Is she your teacher? — No, she isn’t."
            ],
            "examples": [
                "Are you ready? / Siz tayyormisiz?",
                "Is he your teacher? / U sizning ustozingizmi?",
                "Are they ready? / Ular tayyormi?"
            ]
        }
    ],
    "THERE IS / THERE ARE": [
        {
            "icon": "📍",
            "title": "Ma’nosi: bor / mavjud",
            "formula": "There is / There are = bor",
            "text": "Bu mavzu biror joyda narsa yoki odam borligini aytadi. Xona, rasm, stol usti, sumka ichi, ko‘cha yoki shaharni tasvirlashda juda kerak.",
            "points": [
                "There is a book — kitob bor",
                "There are books — kitoblar bor",
                "Asosiy savol: nechta narsa bor?"
            ],
            "examples": [
                "There is a book on the table. / Stol ustida kitob bor.",
                "There are students in the classroom. / Sinfxonada o‘quvchilar bor.",
                "There is a park near my house. / Uyim yaqinida park bor."
            ]
        },
        {
            "icon": "1️⃣",
            "title": "There is — birlik yoki sanalmaydigan ot",
            "formula": "There is + singular noun\nThere is + uncountable noun",
            "text": "Bitta narsa yoki sanalmaydigan narsa haqida gapirganda there is ishlatiladi.",
            "points": [
                "a book — birlik",
                "a teacher — birlik",
                "water/milk — sanalmaydigan"
            ],
            "examples": [
                "There is a teacher in the room. / Xonada bitta ustoz bor.",
                "There is some water in the glass. / Stakanda biroz suv bor.",
                "There is a phone in my bag. / Sumkamda telefon bor."
            ]
        },
        {
            "icon": "🔢",
            "title": "There are — ko‘plik ot",
            "formula": "There are + plural noun",
            "text": "Ikki yoki undan ko‘p narsa bo‘lsa there are ishlatiladi. Oldida two, three, many, some kabi so‘zlar bo‘lsa ko‘pincha are kerak bo‘ladi.",
            "points": [
                "two chairs → there are",
                "many students → there are",
                "some apples → there are"
            ],
            "examples": [
                "There are two chairs. / Ikkita stul bor.",
                "There are many students. / Ko‘p o‘quvchilar bor.",
                "There are some apples. / Bir nechta olmalar bor."
            ]
        },
        {
            "icon": "❓",
            "title": "Inkor va savol",
            "formula": "There isn’t + singular\nThere aren’t any + plural\nIs there...? / Are there...?",
            "text": "Biror narsa yo‘qligini aytish yoki bor-yo‘qligini so‘rash uchun inkor va savol shakllari ishlatiladi. Savol va inkorda any juda ko‘p uchraydi.",
            "points": [
                "Is there a bank? — Bank bormi?",
                "Are there any chairs? — Stullar bormi?",
                "There aren’t any chairs — Stullar yo‘q"
            ],
            "examples": [
                "There isn't a computer in the room. / Xonada kompyuter yo‘q.",
                "There aren't any chairs here. / Bu yerda stullar yo‘q.",
                "Is there a bank near here? / Bu yer yaqinida bank bormi?"
            ]
        }
    ]
};
  if (upgradedCards[title]) return upgradedCards[title];

  const cards = {
    'A / AN': [
      {
        icon: '🅰️',
        title: 'A — undosh tovush',
        formula: 'a + singular countable noun\nA tovush undosh bilan boshlansa ishlatiladi',
        examples: ['a dog / bitta it', 'a pen / bitta ruchka', 'a university / universitet']
      },
      {
        icon: '🔤',
        title: 'An — unli tovush',
        formula: 'an + singular countable noun\nAn tovush unli bilan boshlansa ishlatiladi',
        examples: ['an apple / bitta olma', 'an elephant / bitta fil', 'an hour / bir soat']
      },
      {
        icon: '🚫',
        title: 'A/An ishlatilmaydi',
        formula: 'no a/an + plural noun\nno a/an + uncountable noun',
        examples: ['books / kitoblar — a books emas', 'water / suv — a water emas', 'students / o‘quvchilar — a students emas']
      }
    ],
    'PLURALS (REGULAR)': [
      {
        icon: '📌',
        title: 'Oddiy qoida: -s',
        formula: 'Ko‘p otlarda oxiriga -s qo‘shiladi',
        examples: ['one flower — two flowers / bitta gul — ikkita gul', 'one zebra — four zebras / bitta zebra — to‘rtta zebra', 'one lion — three lions / bitta sher — uchta sher']
      },
      {
        icon: '➕',
        title: 'Oxiri s, ss, sh, ch, x, o bo‘lsa: -es',
        formula: 'Ayrim oxirgi tovushlardan keyin -es qo‘shiladi',
        examples: ['one bus — two buses / bitta avtobus — ikkita avtobus', 'one box — three boxes / bitta quti — uchta quti', 'one watch — two watches / bitta soat — ikkita soat']
      },
      {
        icon: '🔁',
        title: 'Undosh + y: y → ies',
        formula: 'Undosh + y oxirida -ies, unli + y oxirida -s',
        examples: ['one baby — two babies / bitta chaqaloq — ikkita chaqaloq', 'one city — three cities / bitta shahar — uchta shahar', 'one boy — two boys / bitta bola — ikkita bola']
      },
      {
        icon: '🚫',
        title: 'Ko‘plikda a/an ishlatilmaydi',
        formula: 'a/an + singular noun\nno a/an + plural noun',
        examples: ['a book — two books / a books emas', 'an apple — three apples / an apples emas', 'many students / a many students emas']
      }
    ],
    'SUBJECT PRONOUN': [
      {
        icon: "👤",
        title: "Subject pronoun nima?",
        formula: "Subject pronoun = ega o‘rnida keladigan olmosh\nU gapda kim yoki nima haqida gap ketayotganini bildiradi",
        text: "Subject pronoun ismni qayta-qayta takrorlamaslik uchun ishlatiladi. Masalan: John is my brother. He is my brother. Bu yerda He so‘zi John o‘rnida ishlatilgan.",
        points: ["Subject pronoun gap boshida ko‘p keladi.", "U odam, narsa yoki guruh o‘rnida ishlatiladi.", "Subject pronoundan keyin odatda fe’l keladi."],
        examples: ["John is my brother. He is my brother. / John mening akam. U mening akam.", "Children are playing. They are playing. / Bolalar o‘ynayapti. Ular o‘ynayapti."]
      },
      {
        icon: "1️⃣",
        title: "Birlikda (Singular)",
        formula: "I = men\nyou = sen / siz\nhe = u — erkak\nshe = u — ayol\nit = u — narsa yoki hayvon",
        text: "Birlik olmoshlari bitta shaxs, bitta narsa yoki bitta hayvon haqida gapirganda ishlatiladi.",
        points: ["I doim katta harf bilan yoziladi.", "He erkak kishi uchun ishlatiladi.", "She ayol kishi uchun ishlatiladi.", "It narsa, hayvon yoki ob-havo uchun ishlatiladi."],
        examples: ["Ali is a pupil. He is a pupil. / Ali o‘quvchi. U o‘quvchi.", "Malika is my sister. She is my sister. / Malika singlim. U singlim.", "The book is red. It is red. / Kitob qizil. U qizil."]
      },
      {
        icon: "👥",
        title: "Ko‘plikda (Plural)",
        formula: "we = biz\nyou = siz / sizlar\nthey = ular",
        text: "Ko‘plik olmoshlari ikki yoki undan ko‘p odam/narsa haqida gapirganda ishlatiladi. You bitta odamga ham, ko‘p odamga ham ishlatilishi mumkin.",
        points: ["We — men va yana kimdir: biz.", "They — ikki yoki undan ko‘p odam/narsa: ular.", "You — bitta odamga ham, ko‘pchilikka ham aytiladi."],
        examples: ["My friends are here. They are here. / Do‘stlarim shu yerda. Ular shu yerda.", "You and I are students. We are students. / Sen va men o‘quvchimiz. Biz o‘quvchimiz.", "You are my friend. / Siz mening do‘stimsiz."]
      },
      {
        icon: "🔁",
        title: "Ismni olmosh bilan almashtirish",
        formula: "John → he\nMary → she\na book → it\nJohn and Mary → they",
        text: "Gapda ism birinchi marta aytiladi. Keyingi gaplarda shu ism o‘rniga mos subject pronoun ishlatiladi.",
        points: ["Erkak ism → he.", "Ayol ism → she.", "Narsa yoki hayvon → it.", "Ko‘plik ism yoki ikki odam → they."],
        examples: ["My father is a doctor. He is a doctor. / Otam shifokor. U shifokor.", "The cats are small. They are small. / Mushuklar kichkina. Ular kichkina.", "The phone is new. It is new. / Telefon yangi. U yangi."]
      }
    ],
    'TO BE': [
      {
        icon: '✅',
        title: 'Positive',
        formula: 'I am ...\nHe / She / It is ...\nYou / We / They are ...',
        examples: ['I am a student. / Men o‘quvchiman.', 'She is happy. / U xursand.', 'They are at school. / Ular maktabda.']
      },
      {
        icon: '➖',
        title: 'Negative',
        formula: 'I am not ...\nHe / She / It is not ...\nYou / We / They are not ...',
        examples: ['I am not tired. / Men charchagan emasman.', 'He is not busy. / U band emas.', 'We are not late. / Biz kechikkan emasmiz.']
      },
      {
        icon: '❓',
        title: 'Question',
        formula: 'Am I ...?\nIs he / she / it ...?\nAre you / we / they ...?',
        examples: ['Are you ready? / Siz tayyormisiz?', 'Is she your teacher? / U sizning ustozingizmi?', 'Are they ready? / Ular tayyormi?']
      }
    ],
    'PRESENT CONTINUOUS': [
      {
        icon: '✅',
        title: 'Positive',
        formula: 'Subject + am/is/are + verb-ing',
        text: 'Darak gapda ega keladi, keyin am/is/are, keyin fe’lning -ing shakli yoziladi.',
        points: ['I bilan am ishlatiladi.', 'He / she / it bilan is ishlatiladi.', 'You / we / they bilan are ishlatiladi.'],
        examples: ['I am reading now. / Men hozir o‘qiyapman.', 'She is cooking dinner. / U kechki ovqat pishiryapti.']
      },
      {
        icon: '➖',
        title: 'Negative',
        formula: 'Subject + am/is/are + not + verb-ing',
        text: 'Inkor gapda to be fe’lidan keyin not qo‘yiladi.',
        points: ['am not = emasman / qilmayapman', 'is not = isn’t', 'are not = aren’t'],
        examples: ['I am not working now. / Men hozir ishlamayapman.', 'They are not playing football. / Ular futbol o‘ynamayapti.']
      },
      {
        icon: '❓',
        title: 'Question',
        formula: 'Am/Is/Are + subject + verb-ing?',
        text: 'Savolda am/is/are gap boshiga chiqadi. What, where, why kabi savol so‘zlari bo‘lsa, ular eng boshida turadi.',
        points: ['Are you ...? — Siz ... qilyapsizmi?', 'Is he/she ...? — U ... qilyaptimi?', 'What are you doing? — Nima qilyapsiz?'],
        examples: ['Are you studying now? / Hozir o‘qiyapsizmi?', 'What are they doing? / Ular nima qilyapti?']
      },
      {
        icon: '✍️',
        title: 'Spelling rules',
        formula: 'Ko‘p fe’llar: verb + ing\nOxiri -e bo‘lsa: e tushadi + ing\nQisqa fe’llarda: oxirgi undosh takrorlanishi mumkin',
        text: 'Present Continuousda asosiy fe’l -ing shakliga o‘tadi. Ba’zi fe’llarda yozilish qoidasi o‘zgaradi.',
        points: ['work → working, read → reading', 'write → writing, dance → dancing', 'run → running, swim → swimming'],
        examples: ['I am writing a letter. / Men xat yozyapman.', 'The children are running. / Bolalar yuguryapti.']
      }
    ],
    'PRESENT SIMPLE': [
      {
        icon: '📘',
        title: 'Present Simple nima?',
        formula: 'Present Simple = doimiy yoki qaytarilib turadigan ish-harakat\nO‘zbekchada ko‘pincha -adi / -ydi / -aman ma’nosini beradi',
        text: 'Bu zamon odat, kun tartibi, doimiy holat, jadval va umumiy haqiqatlar uchun ishlatiladi.',
        points: ['Har kuni yoki odatda qilinadigan ishlar.', 'Doimiy ish yoki yashash joyi.', 'Tabiat qonuni yoki umumiy fakt.'],
        examples: ['I go to school every day. / Men har kuni maktabga boraman.', 'You work at the hospital. / Siz shifoxonada ishlaysiz.']
      },
      {
        icon: '✅',
        title: 'Positive',
        formula: 'I / you / we / they + V1\nHe / she / it + V-s/es',
        text: 'I, you, we, they bilan fe’lning oddiy shakli keladi. He, she, it bilan darak gapda fe’lga -s yoki -es qo‘shiladi.',
        points: ['I work, you work, we work, they work.', 'He works, she works, it works.', 'go → goes, watch → watches, study → studies.'],
        examples: ['I go to school every day. / Men har kuni maktabga boraman.', 'She watches TV in the evening. / U kechqurun televizor ko‘radi.']
      },
      {
        icon: '➖',
        title: 'Negative',
        formula: 'I / you / we / they + do not + V1\nHe / she / it + does not + V1',
        text: 'Inkor gapda do not yoki does not ishlatiladi. Does ishlatilganda asosiy fe’lga -s/-es qo‘shilmaydi.',
        points: ["do not = don't", "does not = doesn't", 'doesn’t + V1: doesn’t go, doesn’t like.'],
        examples: ["I don’t like coffee. / Men kofeni yoqtirmayman.", "Tom doesn’t work at school. / Tom maktabda ishlamaydi."]
      },
      {
        icon: '❓',
        title: 'Question',
        formula: 'Do + I / you / we / they + V1?\nDoes + he / she / it + V1?',
        text: 'Savol gapda do yoki does gap boshiga chiqadi. He/she/it bilan savolda does ishlatiladi va asosiy fe’l V1 bo‘lib qoladi.',
        points: ['Do you ...? — Siz ... qilasizmi?', 'Does she ...? — U ... qiladimi?', 'Does he goes? emas, Does he go?'],
        examples: ['Do you speak English? / Siz inglizcha gapirasizmi?', 'Does she speak English? / U inglizcha gapiradimi?']
      },
      {
        icon: '✍️',
        title: 'Spelling rules',
        formula: 's, sh, ch, x, o + es\nconsonant + y → ies\nother verbs + s',
        text: 'He/she/it bilan fe’lga -s yoki -es qo‘shiladi. Ba’zi fe’llarda yozilish qoidasi o‘zgaradi.',
        points: ['brush → brushes, watch → watches, do → does, go → goes.', 'cry → cries, fly → flies.', 'know → knows, walk → walks, play → plays.'],
        examples: ['He goes to school every day. / U har kuni maktabga boradi.', 'My mother works at the hospital. / Onam shifoxonada ishlaydi.']
      }
    ],
    'PRESENT SIMPLE & PRESENT CONTINUOUS': [
      {
        icon: '✅',
        title: 'Present Simple',
        formula: 'Subject + V1/V-s\nUse it for habits and facts',
        examples: ['I usually walk to school. / Men odatda maktabga piyoda boraman.', 'She works in a bank. / U bankda ishlaydi.']
      },
      {
        icon: '🔄',
        title: 'Present Continuous',
        formula: 'Subject + am/is/are + verb-ing\nUse it for actions happening now',
        examples: ['I am walking to school now. / Men hozir maktabga piyoda ketyapman.', 'She is working late today. / U bugun kechgacha ishlayapti.']
      },
      {
        icon: '❓',
        title: 'Question',
        formula: 'Do/Does + subject + V1?\nAm/Is/Are + subject + verb-ing?',
        examples: ['Do you play tennis? / Tennis o‘ynaysizmi?', 'Are you playing tennis now? / Hozir tennis o‘ynayapsizmi?']
      }
    ],
    'PAST SIMPLE': [
      {
        icon: '✅',
        title: 'Positive',
        formula: 'Subject + V2\nRegular verb + -ed / Irregular verb: went, saw, did',
        examples: ['I watched TV yesterday. / Men kecha televizor ko‘rdim.', 'She went to Samarkand last week. / U o‘tgan hafta Samarqandga bordi.']
      },
      {
        icon: '➖',
        title: 'Negative',
        formula: 'Subject + did not + V1',
        examples: ['He did not come to class. / U darsga kelmadi.', 'They did not play yesterday. / Ular kecha o‘ynamadi.']
      },
      {
        icon: '❓',
        title: 'Question',
        formula: 'Did + subject + V1?',
        examples: ['Did you see Ali? / Alini ko‘rdingizmi?', 'Where did you go yesterday? / Kecha qayerga bordingiz?']
      }
    ],
    'PAST CONTINUOUS': [
      {
        icon: '✅',
        title: 'Positive',
        formula: 'Subject + was/were + verb-ing',
        examples: ['I was doing my homework at 8. / Soat 8 da uy vazifamni qilayotgan edim.', 'They were watching TV. / Ular televizor ko‘rayotgan edi.']
      },
      {
        icon: '➖',
        title: 'Negative',
        formula: 'Subject + was/were + not + verb-ing',
        examples: ['We were not sleeping. / Biz uxlamayotgan edik.', 'She was not cooking. / U ovqat qilmayotgan edi.']
      },
      {
        icon: '❓',
        title: 'Question',
        formula: 'Was/Were + subject + verb-ing?',
        examples: ['Were you studying at 9? / Soat 9 da o‘qiyotgan edingizmi?', 'What were you doing yesterday evening? / Kecha kechqurun nima qilayotgan edingiz?']
      }
    ],
    'FUTURE SIMPLE / TO BE GOING TO': [
      {
        icon: '✅',
        title: 'Positive',
        formula: 'Subject + will + V1\nSubject + am/is/are + going to + V1',
        examples: ['I will call you later. / Men sizga keyin qo‘ng‘iroq qilaman.', 'She is going to buy a new phone. / U yangi telefon sotib olmoqchi.']
      },
      {
        icon: '➖',
        title: 'Negative',
        formula: 'Subject + will not + V1\nSubject + am/is/are + not + going to + V1',
        examples: ['I will not be late. / Men kech qolmayman.', 'We are not going to stay long. / Biz uzoq qolmoqchi emasmiz.']
      },
      {
        icon: '❓',
        title: 'Question',
        formula: 'Will + subject + V1?\nAm/Is/Are + subject + going to + V1?',
        examples: ['Will you help me? / Menga yordam berasizmi?', 'Are you going to study tonight? / Bugun kechqurun o‘qimoqchimisiz?']
      }
    ],
    'PRESENT PERFECT': [
      {
        icon: '✅',
        title: 'Positive',
        formula: 'Subject + have/has + V3',
        examples: ['I have finished my homework. / Men uy vazifamni tugatdim.', 'She has visited Samarkand. / U Samarqandga borgan.']
      },
      {
        icon: '➖',
        title: 'Negative',
        formula: 'Subject + have/has + not + V3',
        examples: ['They have not arrived yet. / Ular hali yetib kelmagan.', 'He has not done his homework. / U uy vazifasini bajarmagan.']
      },
      {
        icon: '❓',
        title: 'Question',
        formula: 'Have/Has + subject + V3?',
        examples: ['Have you ever seen snow? / Hech qor ko‘rganmisiz?', 'Has she finished the test? / U testni tugatdimi?']
      }
    ],
    'PRESENT PERFECT INTRO': [
      {
        icon: '✅',
        title: 'Positive',
        formula: 'I/you/we/they + have + V3\nHe/she/it + has + V3',
        examples: ['I have finished my test. / Men testimni tugatdim.', 'She has cleaned the room. / U xonani tozalagan.']
      },
      {
        icon: '➖',
        title: 'Negative',
        formula: 'Subject + have/has + not + V3',
        examples: ['He has not done his homework yet. / U hali uy vazifasini bajarmagan.', 'We have never played this game. / Biz bu o‘yinni hech o‘ynamaganmiz.']
      },
      {
        icon: '❓',
        title: 'Question',
        formula: 'Have/Has + subject + V3?',
        examples: ['Have you ever been to Tashkent? / Hech Toshkentda bo‘lganmisiz?', 'Has he opened the door? / U eshikni ochdimi?']
      }
    ],
    'THERE IS / THERE ARE': [
      {
        icon: '✅',
        title: 'Positive',
        formula: 'There is + singular noun\nThere are + plural noun',
        examples: ['There is a book on the table. / Stol ustida bitta kitob bor.', 'There are three books on the table. / Stol ustida uchta kitob bor.']
      },
      {
        icon: '➖',
        title: 'Negative',
        formula: "There is not + singular noun\nThere are not any + plural noun",
        examples: ["There isn't a computer in the room. / Xonada kompyuter yo‘q.", "There aren't any chairs here. / Bu yerda stullar yo‘q."]
      },
      {
        icon: '❓',
        title: 'Question',
        formula: 'Is there + singular noun?\nAre there any + plural noun?',
        examples: ['Is there a bank near here? / Bu yer yaqinida bank bormi?', 'Are there any students in the classroom? / Sinfxonada o‘quvchilar bormi?']
      }
    ],
    'HAVE / HAS': [
      {
        icon: '✅',
        title: 'Have',
        formula: 'I / you / we / they + have',
        examples: ['I have a new phone. / Menda yangi telefon bor.', 'They have English books. / Ularda ingliz tili kitoblari bor.']
      },
      {
        icon: '✅',
        title: 'Has',
        formula: 'He / she / it + has',
        examples: ['She has two brothers. / Uning ikkita aka-ukasi bor.', 'Ali has a red pen. / Alida qizil ruchka bor.']
      },
      {
        icon: '🎯',
        title: 'Asosiy farq',
        formula: 'Ko‘plik yoki I/you/we/they → have\nBitta odam/narsa yoki he/she/it → has',
        examples: ['We have a classroom. / Bizda sinfxona bor.', 'The school has many rooms. / Maktabda ko‘p xonalar bor.']
      }
    ],
    'CAN / CAN\'T': [
      {
        icon: '✅',
        title: 'Positive',
        formula: 'Subject + can + V1\nCan hamma shaxslar bilan bir xil ishlatiladi',
        text: 'Can qila olmoq yoki mumkin degan ma’noni beradi. Can dan keyin fe’lning oddiy shakli keladi.',
        points: ['I can, you can, he can, she can, we can, they can.', 'Can dan keyin to kelmaydi.', 'Can dan keyin fe’lga -s qo‘shilmaydi.'],
        examples: ['I can read. / Men o‘qiy olaman.', 'She can speak English. / U ingliz tilida gapira oladi.', 'They can dance. / Ular raqs tusha oladi.']
      },
      {
        icon: '➖',
        title: 'Negative',
        formula: 'Subject + can not + V1\nSubject + can’t + V1',
        text: 'Inkor shaklda can dan keyin not keladi. Kundalik ingliz tilida ko‘pincha can’t ishlatiladi.',
        points: ['cannot va can not yozilishi mumkin.', 'Qisqa shakli: can’t.', 'Can’t dan keyin ham fe’l V1 bo‘ladi.'],
        examples: ['I can’t swim. / Men suza olmayman.', 'He can’t drive a car. / U mashina hayday olmaydi.', 'You can’t run fast. / Siz tez yugura olmaysiz.']
      },
      {
        icon: '❓',
        title: 'Question',
        formula: 'Can + subject + V1?',
        text: 'Savolda Can gap boshiga chiqadi. Javobda Yes, I can yoki No, I can’t ishlatiladi.',
        points: ['Can you...? — Siz ... qila olasizmi?', 'Can I...? — Men ... qilsam bo‘ladimi?', 'Savolda do/does kerak emas.'],
        examples: ['Can you sing? / Qo‘shiq ayta olasizmi?', 'Can she speak English? / U ingliz tilida gapira oladimi?', 'Can I come in? / Kirsam bo‘ladimi?']
      }
    ],
    'WHO / WHAT': [
      {
        icon: '👤',
        title: 'Who — kim?',
        formula: 'Who + is/are ...?\nWho + do/does ...?',
        text: 'Who odamlar haqida so‘rash uchun ishlatiladi. Javob odatda odam yoki shaxs bo‘ladi.',
        points: ['Who = kim?', 'Teacher, friend, boy, girl kabi odamlar haqida so‘raydi.', 'Who is...? va Who called...? shakllari ko‘p ishlatiladi.'],
        examples: ['Who is he? / U kim?', 'Who is your teacher? / Sizning ustozingiz kim?', 'Who called you? / Sizga kim qo‘ng‘iroq qildi?']
      },
      {
        icon: '❔',
        title: 'What — nima?',
        formula: 'What + is/are ...?\nWhat + do/does ...?',
        text: 'What narsa, ism, kasb, raqam, ma’lumot yoki ish-harakat haqida so‘rash uchun ishlatiladi.',
        points: ['What = nima?', 'Narsa uchun: What is this?', 'Ma’lumot uchun: What is your name?', 'Ish-harakat uchun: What are you doing?'],
        examples: ['What is this? / Bu nima?', 'What is your name? / Ismingiz nima?', 'What are you doing? / Nima qilyapsiz?']
      },
      {
        icon: '🔁',
        title: 'Who va What farqi',
        formula: 'Who → person\nWhat → thing / information / action',
        text: 'Who odamga, What esa narsa yoki ma’lumotga tegishli. Savolda yordamchi fe’lni tashlab ketmang.',
        points: ['Who is your friend? — do‘st odam.', 'What is your phone number? — raqam/ma’lumot.', 'What do you do? — kasb yoki ish haqida savol.'],
        examples: ['Who is that woman? / Ana u ayol kim?', 'What is your job? / Kasbingiz nima?', 'What do you want? / Nima xohlaysiz?']
      }
    ],
    'PREPOSITION OF PLACE': [
      {
            "icon": "📦",
            "title": "in — ichida",
            "formula": "in + noun/place\nNarsa yoki odam bir joyning ichida bo‘lsa in ishlatiladi.",
            "examples": [
                  "The rabbit is in the hat. / Quyon shlyapa ichida.",
                  "The keys are in my bag. / Kalitlar sumkam ichida."
            ],
            "text": "",
            "points": []
      },
      {
            "icon": "🪑",
            "title": "on — ustida / yuzasida",
            "formula": "on + noun/place\nNarsa biror yuzaning ustida yoki devorda bo‘lsa on ishlatiladi.",
            "examples": [
                  "The book is on the table. / Kitob stol ustida.",
                  "The picture is on the wall. / Rasm devorda."
            ],
            "text": "",
            "points": []
      },
      {
            "icon": "⬇️",
            "title": "under / behind / next to",
            "formula": "under — ostida\nbehind — orqasida\nnext to — yonida",
            "examples": [
                  "The ball is under the chair. / To‘p stul ostida.",
                  "The boy is behind the door. / Bola eshik orqasida.",
                  "Ali is next to me. / Ali yonimda."
            ],
            "text": "",
            "points": []
      },
      {
            "icon": "↔️",
            "title": "between / in front of",
            "formula": "between — ikki narsa orasida\nin front of — oldida",
            "examples": [
                  "The school is between the bank and the shop. / Maktab bank va do‘kon orasida.",
                  "The car is in front of the house. / Mashina uy oldida."
            ],
            "text": "",
            "points": []
      }
],
    'PREPOSITION OF TIME': [
      {
            "icon": "⏰",
            "title": "at — aniq vaqt",
            "formula": "at + exact time\nat 9 o’clock\nat night",
            "examples": [
                  "The lesson starts at 9 o’clock. / Dars soat 9 da boshlanadi.",
                  "We sleep at night. / Biz tunda uxlaymiz."
            ],
            "text": "",
            "points": []
      },
      {
            "icon": "📅",
            "title": "on — kun yoki sana",
            "formula": "on + day\non + date\non Monday\non 15 May",
            "examples": [
                  "We have English on Monday. / Bizda dushanba kuni ingliz tili bor.",
                  "The test is on 15 May. / Test 15-may kuni."
            ],
            "text": "",
            "points": []
      },
      {
            "icon": "🗓️",
            "title": "in — oy, yil, fasl, kun qismi",
            "formula": "in + month\nin + year\nin + season\nin the morning / afternoon / evening",
            "examples": [
                  "My birthday is in June. / Mening tug‘ilgan kunim iyun oyida.",
                  "She was born in 2010. / U 2010-yilda tug‘ilgan.",
                  "I study in the morning. / Men ertalab o‘qiyman."
            ],
            "text": "",
            "points": []
      },
      {
            "icon": "✅",
            "title": "Eslab qolish usuli",
            "formula": "at = aniq vaqt\non = kun yoki sana\nin = oy / yil / fasl / kun qismi",
            "examples": [
                  "The lesson starts at 9 o’clock. / Dars soat 9 da boshlanadi.",
                  "We have English on Monday. / Bizda dushanba kuni ingliz tili bor.",
                  "My birthday is in June. / Mening tug‘ilgan kunim iyunda."
            ],
            "text": "Bu mavzuda faqat uchta asosiy vaqt predlogi o‘rganiladi: at, on, in.",
            "points": []
      }
]
  };

  return (cards[title] || []).map(card => ({
    ...card,
    text: '',
    points: []
  }));
}

function findExplanationPart(parts, words) {
  return (parts || []).find(part => {
    const heading = String(part.heading || '').toLowerCase();
    return words.some(word => heading.includes(word));
  });
}

function buildFormCards(topic, examples, explanationParts = []) {
  const title = topic.title || 'Mavzu';
  if (isCleanWorkbookTopic(topic)) {
    const structuredCards = getCleanTopicFormCards(topic);
    if (structuredCards.length) return structuredCards;
    const form = findExplanationPart(explanationParts, ['shakl', 'formula']);
    return form?.text ? [{
      icon: '🔹',
      title: 'Shakl',
      formula: form.text,
      text: '',
      points: [],
      examples: []
    }] : [];
  }
  if (isToBeTopic(topic)) {
    return [
      {
        icon: '✅',
        title: 'Darak gap',
        formula: 'Ega + am/is/are + qolgan so‘zlar',
        text: 'Darak gap oddiy xabar beradi. Avval ega keladi, keyin egaga mos am, is yoki are qo‘yiladi. Undan keyin gapning qolgan qismi yoziladi.',
        points: ['I bilan am ishlatiladi.', 'He / She / It bilan is ishlatiladi.', 'You / We / They bilan are ishlatiladi.'],
        examples: ['I am a student. / Men o‘quvchiman.', 'She is my teacher. / U mening ustozim.', 'They are friends. / Ular do‘stlar.']
      },
      {
        icon: '➖',
        title: 'Inkor gap',
        formula: 'Ega + am/is/are + not + qolgan so‘zlar',
        text: 'Inkor gapda “emas” ma’nosi beriladi. Buning uchun am, is yoki are dan keyin not qo‘yiladi. So‘z tartibi buzilmaydi, faqat not qo‘shiladi.',
        points: ['I am not — men ... emasman.', 'He / She / It is not — u ... emas.', 'You / We / They are not — siz/biz/ular ... emas.'],
        examples: ['I am not tired. / Men charchagan emasman.', 'He is not busy. / U band emas.', 'They are not at home. / Ular uyda emas.']
      },
      {
        icon: '❓',
        title: 'So‘roq gap',
        formula: 'Am/Is/Are + ega + qolgan so‘zlar?',
        text: 'So‘roq gapda savol beriladi. To be fe’li gap boshiga chiqadi: am, is yoki are birinchi keladi, keyin ega yoziladi.',
        points: ['Are you ...? — Siz ...misiz?', 'Is he/she/it ...? — U ...mi?', 'Are they ...? — Ular ...mi?'],
        examples: ['Is he at home? / U uydami?', 'Are you ready? / Siz tayyormisiz?', 'Are they in the classroom? / Ular sinfxonadami?']
      }
    ];
  }

  return [
    {
      icon: '✅',
      title: 'Darak gap',
      formula: `${title} qoidasini oddiy gap ichida ishlatish`,
      text: 'Darak gapda fikr tasdiq shaklida aytiladi. Avval gapning egasini toping, keyin mavzuga mos qoida yoki fe’l shaklini joylashtiring.',
      points: ['Gap egasini aniqlang.', 'Mavzuga mos qoida yoki fe’l shaklini tanlang.', 'Gapni to‘liq va sodda yozing.'],
      examples: examples.slice(0, 3)
    },
    {
      icon: '➖',
      title: 'Inkor gap',
      formula: 'Ega + mavzuga mos inkor shakli + qolgan so‘zlar',
      text: 'Inkor gapda fikr rad etiladi. Ingliz tilida ko‘pincha not, do not, does not, did not yoki mavzuga mos boshqa inkor shakli ishlatiladi.',
      points: ['Avval darak gapni tuzing.', 'Keyin mavzuga mos inkor so‘zini qo‘shing.', 'Fe’l yoki yordamchi fe’l shakliga e’tibor bering.'],
      examples: examples.slice(3, 6).length ? examples.slice(3, 6) : examples.slice(0, 3)
    },
    {
      icon: '❓',
      title: 'So‘roq gap',
      formula: 'Yordamchi fe’l / savol so‘zi + ega + qolgan so‘zlar?',
      text: 'So‘roq gapda javob olish uchun gap tartibi o‘zgaradi. Ko‘pincha yordamchi fe’l yoki savol so‘zi gap boshiga chiqadi.',
      points: ['Savol nima haqida ekanini aniqlang.', 'Yordamchi fe’l yoki savol so‘zini boshiga qo‘ying.', 'Gap oxirida savol belgisi qo‘ying.'],
      examples: examples.slice(0, 3)
    }
  ];
}


function PronunciationSpeakingPractice({ topic, vocabulary, stepNo, onSaved }) {
  const words = (vocabulary || []).slice(0, 30);
  const [activeIndex, setActiveIndex] = useState(0);
  const [listening, setListening] = useState(false);
  const [checkingPronunciation, setCheckingPronunciation] = useState(false);
  const [status, setStatus] = useState('So‘zni tanlang, avval eshiting, keyin mikrofonga ayting.');
  const [spokenText, setSpokenText] = useState('');
  const [checkResult, setCheckResult] = useState(null);
  const [checkedScores, setCheckedScores] = useState({});
  const [batchVocabularyItems, setBatchVocabularyItems] = useState({});
  const [batchChecking, setBatchChecking] = useState(false);
  const [batchFeedback, setBatchFeedback] = useState(null);
  const [speakingSummary, setSpeakingSummary] = useState({
    score: topic.speakingScore || 0,
    checkedWords: topic.speakingCheckedWords || 0,
    passedWords: topic.speakingPassedWords || 0,
    totalWords: topic.speakingTotalWords || 30,
    attempts: topic.speakingAttempts || 0
  });

  useEffect(() => {
    setActiveIndex(0);
    setSpokenText('');
    setCheckResult(null);
    setCheckedScores({});
    setBatchVocabularyItems({});
    setBatchFeedback(null);
    setBatchChecking(false);
    setSpeakingSummary({
      score: topic.speakingScore || 0,
      checkedWords: topic.speakingCheckedWords || 0,
      passedWords: topic.speakingPassedWords || 0,
      totalWords: topic.speakingTotalWords || 30,
      attempts: topic.speakingAttempts || 0
    });
  }, [topic.id]);

  const activeWord = words[activeIndex] || { word: topic.title, meaning: '', example: '' };
  const expected = activeWord.word || topic.title;
  const speechSupported = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const batchItemCount = Object.keys(batchVocabularyItems).length;
  const allVocabularyPronounced = words.length > 0 && words.every(item => Boolean(batchVocabularyItems[item.word]));

  function playWord() {
    if (listening || checkingPronunciation) {
      setStatus('Talaffuz tekshirilmoqda. Tekshiruv tugagandan keyin eshitish mumkin.');
      return;
    }
    if (!('speechSynthesis' in window)) {
      setStatus('Brauzeringiz ovoz chiqarib o‘qishni qo‘llab-quvvatlamaydi.');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(expected);
    utterance.lang = getSpeechLang(topic.language);
    utterance.rate = 0.82;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
    setStatus('So‘zni diqqat bilan eshiting va xuddi shunday talaffuz qiling.');
  }

  function nextWord() {
    setActiveIndex(index => Math.min(words.length - 1, index + 1));
    setSpokenText('');
    setCheckResult(null);
    setStatus('Keyingi so‘z tanlandi. Avval eshiting, keyin mikrofonga ayting.');
  }

  async function saveSpeakingProgress(result, transcript) {
    try {
      const data = await api(`/api/speaking-progress/${topic.language}/${topic.level}/${topic.topicNo}`, {
        method: 'POST',
        body: JSON.stringify({
          word: activeWord.word,
          expected,
          meaning: activeWord.meaning,
          spoken: transcript,
          score: result.score,
          passed: result.passed
        })
      });
      if (data.topic) {
        setSpeakingSummary(data.topic);
        onSaved?.(topic, data.topic, data.speakingSummary);
      }
    } catch (err) {
      setStatus(prev => `${prev} Natija statistikaga saqlanmadi: ${err.message}`);
    }
  }

  async function processTranscript(transcript) {
    setCheckingPronunciation(true);
    setStatus('Mahalliy tekshiruv bajarilmoqda. Hamma vocabulary aytilgandan keyin bitta qilib yuboriladi.');
    const localScore = similarityScore(expected, transcript);
    const result = {
      score: localScore,
      passed: localScore >= 75,
      feedback: localScore >= 85
        ? 'Juda yaxshi! Talaffuz aniq eshitildi. Hamma so‘z tugagach “Vocabulary yuborish” tugmasi chiqadi.'
        : localScore >= 65
          ? 'Yaxshi, lekin so‘zni yana bir marta sekinroq va aniqroq ayting. AI tekshiruv hamma so‘z tugagandan keyin bitta request bo‘ladi.'
          : 'So‘z to‘liq mos kelmadi. Avval eshitib oling, keyin qayta ayting.'
    };
    setCheckingPronunciation(false);

    const itemPayload = {
      id: activeWord.id || expected,
      word: activeWord.word,
      expected,
      meaning: activeWord.meaning,
      spoken: transcript,
      score: result.score,
      passed: result.passed
    };

    setBatchVocabularyItems(prev => ({ ...prev, [expected]: itemPayload }));
    setCheckResult(result);
    setCheckedScores(prev => ({ ...prev, [expected]: result.score }));
    setBatchFeedback(null);
    setStatus(result.passed
      ? 'Talaffuz yaxshi. Natija speaking statistikasiga saqlandi. Hamma vocabulary tugagach yuborish tugmasi chiqadi.'
      : 'Qayta urinib ko‘ring yoki keyingi so‘zga o‘ting. Hamma vocabulary tugagach bitta qilib yuboriladi.');
    await saveSpeakingProgress(result, transcript);
  }

  async function checkVocabularyBatchWithAi() {
    const items = Object.values(batchVocabularyItems).slice(0, 30);
    if (!items.length) {
      setStatus('Avval vocabulary so‘zlarini talaffuz qilib chiqing.');
      return;
    }
    if (!allVocabularyPronounced) {
      setStatus(`Hamma vocabulary talaffuz qilinmaguncha yuborib bo‘lmaydi. Hozir: ${batchItemCount}/${words.length}.`);
      return;
    }
    setBatchChecking(true);
    setStatus(`${items.length} ta vocabulary bitta AI request bilan tekshirilmoqda...`);
    try {
      const data = await api('/api/speaking-batch-check', {
        method: 'POST',
        body: JSON.stringify({ language: topic.language, level: topic.level, topicNo: topic.topicNo, items })
      });
      setBatchFeedback(data);
      if (Array.isArray(data.results)) {
        const merged = {};
        data.results.forEach(item => { merged[item.expected || item.word] = item.score; });
        setCheckedScores(prev => ({ ...prev, ...merged }));
      }
      setStatus(`${data.checkedWords || items.length} ta vocabulary bitta AI request bilan tekshirildi. O‘rtacha natija: ${data.score || 0}%.`);
    } catch (err) {
      setStatus(`AI batch tekshiruv ishlamadi: ${err.message}. Mahalliy natijalar saqlangan.`);
    } finally {
      setBatchChecking(false);
    }
  }

  function startListening() {
    if (listening || checkingPronunciation) {
      setStatus('Talaffuz tekshiruvi tugashini kuting.');
      return;
    }
    if (!speechSupported) {
      setStatus('Bu brauzer mikrofon orqali speech recognitionni qo‘llab-quvvatlamaydi. Chrome brauzerida ochib ko‘ring.');
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = getSpeechLang(topic.language);
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      setListening(true);
      setSpokenText('');
      setCheckResult(null);
      setStatus('Tinglayapman... So‘zni aniq ayting.');
    };
    recognition.onerror = event => {
      setListening(false);
      setStatus(event.error === 'not-allowed'
        ? 'Mikrofonga ruxsat berilmagan. Brauzer sozlamasidan microphone accessni yoqing.'
        : 'Mikrofonda xatolik bo‘ldi. Qayta urinib ko‘ring.');
    };
    recognition.onend = () => setListening(false);
    recognition.onresult = event => {
      const transcript = event.results?.[0]?.[0]?.transcript || '';
      setSpokenText(transcript);
      processTranscript(transcript);
    };
    recognition.start();
  }

  if (!words.length) return null;

  return (
    <section className="lessonStepCard speakingCheckStepCard">
      <div className="stepBadge"><span>{stepNo}</span><i>🎤</i></div>
      <div className="stepContent">
        <h3>Speaking: talaffuz tekshiruvi</h3>
        <p>Vocabularydagi har bir so‘zni alohida talaffuz qiling. Hamma 30 ta so‘z aytilgandan keyin “Vocabulary yuborish” tugmasi chiqadi.</p>

        <div className="speakingLiveSummary">
          <div className="speakingMiniRing"><TopicProgressRing value={speakingSummary.score || 0} /><span>Speaking</span></div>
          <div>
            <b>{speakingSummary.checkedWords || 0}/{speakingSummary.totalWords || 30} so‘z tekshirildi</b>
            <small>{speakingSummary.passedWords || 0} ta so‘z 75%+ bilan qabul qilingan · urinishlar: {speakingSummary.attempts || 0}</small>
          </div>
        </div>

        <div className="speakingCheckLayout">
          <div className="practiceWordList">
            {words.map((item, index) => {
              const score = checkedScores[item.word];
              return (
                <button
                  type="button"
                  key={item.id || item.word}
                  className={`practiceWordItem ${index === activeIndex ? 'active' : ''} ${Number(score) >= 75 ? 'done' : ''}`}
                  disabled={listening || checkingPronunciation}
                  onClick={() => {
                    setActiveIndex(index);
                    setSpokenText('');
                    setCheckResult(null);
                    setStatus('So‘z tanlandi. Avval eshiting, keyin mikrofonga ayting.');
                  }}
                >
                  <span>{index + 1}</span>
                  <div>
                    <b>{item.word}</b>
                    <small>{item.meaning}</small>
                  </div>
                  {typeof score !== 'undefined' && <em>{score}%</em>}
                </button>
              );
            })}
          </div>

          <div className="micCheckPanel">
            <div className="currentPracticeWord">
              <small>Tanlangan so‘z</small>
              <b>{expected}</b>
              <span>{activeWord.meaning}</span>
              {activeWord.example && <p>{activeWord.example}</p>}
            </div>

            <div className="micActionGrid">
              <button type="button" className="ghost" onClick={playWord} disabled={listening || checkingPronunciation}>{checkingPronunciation ? 'Tekshirilmoqda...' : '🔊 Eshitish'}</button>
              <button type="button" className="primary" onClick={startListening} disabled={listening || checkingPronunciation}>{checkingPronunciation ? 'Tekshirilmoqda...' : listening ? 'Tinglanmoqda...' : '🎙 Talaffuzni tekshirish'}</button>
            </div>

            <div className={`aiSpeechStatus ${checkResult?.passed ? 'ok' : checkResult ? 'bad' : ''}`}>{status}</div>

            <div className={`speakingBatchBox ${allVocabularyPronounced ? 'ready' : 'locked'}`}>
              <div>
                <b>{batchItemCount}/{words.length} vocabulary talaffuz qilindi</b>
                <span>{allVocabularyPronounced ? 'Hamma vocabulary tayyor. Endi ularni bitta AI request bilan yuborish mumkin.' : 'Vocabulary yuborish tugmasi hamma so‘zlar talaffuz qilingandan keyin chiqadi.'}</span>
              </div>
              {allVocabularyPronounced && (
                <button type="button" className="primary small" onClick={checkVocabularyBatchWithAi} disabled={batchChecking}>
                  {batchChecking ? 'Yuborilmoqda...' : 'Vocabulary yuborish'}
                </button>
              )}
            </div>

            {batchFeedback && (
              <div className="batchAiResult">
                <div><b>{batchFeedback.score || 0}%</b><span>AI batch</span></div>
                <p>{batchFeedback.feedback}</p>
                <small>{batchFeedback.checkedWords || 0} ta so‘z · {batchFeedback.passedWords || 0} tasi 75%+ · request: {batchFeedback.requestCount || 1}</small>
              </div>
            )}

            {spokenText && (
              <div className="spokenResultBox">
                <small>Siz aytdingiz:</small>
                <b>{spokenText}</b>
              </div>
            )}

            {checkResult && (
              <div className="aiResultBox">
                <div className="scoreCircle"><b>{checkResult.score}%</b><span>Local</span></div>
                <div>
                  <h4>{checkResult.passed ? 'Talaffuz qabul qilindi' : 'Yana mashq qiling'}</h4>
                  <p>{checkResult.feedback}</p>
                </div>
              </div>
            )}

            <div className="micActionGrid second">
              <button type="button" className="ghost" onClick={startListening} disabled={listening || checkingPronunciation}>Qayta aytish</button>
              <button type="button" className="ghost" onClick={nextWord} disabled={checkingPronunciation || activeIndex >= words.length - 1}>Keyingi so‘z →</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}



function YouTubeLessonVideo({ video, topicTitle }) {
  if (!video?.videoId) return null;
  const embedUrl = video.embedUrl || `https://www.youtube-nocookie.com/embed/${video.videoId}`;
  const openUrl = video.searchUrl || `https://www.youtube.com/watch?v=${video.videoId}`;
  return (
    <section className="lessonVideoCard">
      <div className="videoText">
        <span className="videoKicker">YouTube video dars</span>
        <h3>{video.title || topicTitle}</h3>
        <p>Avval mavzuni o‘qing, keyin video orqali eshitib tushuning. Video dars mavzuni mustahkamlash uchun qo‘shimcha yordam beradi.</p>
        <a className="youtubeOpenLink" href={openUrl} target="_blank" rel="noreferrer">YouTube’da ochish ↗</a>
      </div>
      <div className="videoFrameWrap">
        <iframe
          title={`${topicTitle} YouTube video dars`}
          src={embedUrl}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          loading="lazy"
        />
      </div>
    </section>
  );
}

function TopicView({ topic, onPracticeSubmit, onGoNext, onBack, onSpeakingSaved }) {
  const [mode, setMode] = useState('lesson');

  useEffect(() => {
    setMode('lesson');
    scrollPageToTop('auto');
  }, [topic?.id]);

  if (mode === 'practice') {
    return <TopicPracticeView topic={topic} onSubmit={onPracticeSubmit} onCancel={() => setMode('lesson')} onNextTopic={onGoNext} />;
  }

  const explanationParts = topic.explanation || [];
  const examples = (topic.examples || []).filter(Boolean);
  const cleanWorkbookLesson = isCleanWorkbookTopic(topic);
  const showVocabulary = hasVocabularyBlockForTopic(topic);
  const vocabulary = showVocabulary ? (topic.vocabulary || []).slice(0, 30) : [];
  const showSpeaking = hasSpeakingPracticeForTopic(topic);
  const showYoutubeVideo = !!topic.youtubeVideo?.videoId;
  const meaning = explanationParts.find(part => String(part.heading || '').toLowerCase().includes('ma’nosi')) || explanationParts[0];
  const usage = explanationParts.find(part => String(part.heading || '').toLowerCase().includes('qachon'));
  const nuance = explanationParts.find(part => { const h = String(part.heading || '').toLowerCase(); return h.includes('farq') || h.includes('eslatma'); });
  const mistakes = explanationParts.find(part => String(part.heading || '').toLowerCase().includes('xato'));
  const formCards = buildFormCards(topic, examples, explanationParts);
  const keyWords = getTopicKeyWords(topic);
  const supportCards = [usage, nuance, mistakes].filter(Boolean);
  const formStepStart = keyWords.length ? 3 : 2;
  const supportStepStart = formStepStart + formCards.length;
  const examplesStepNo = supportStepStart + supportCards.length;
  return (
    <section className="topicDetailPage topicSequentialPage">
      <div className="topicDetailTop">
        <div className="topicBreadcrumb">
          <span>Darslar</span>
          <b>›</b>
          <span>{topic.title}</span>
          <b>›</b>
          <strong>Mavzu tushuntirish</strong>
        </div>
        <div className="topicGoalMini">
          <span>🎯</span>
          <div><b>Maqsad: 90%+</b><small>{showSpeaking ? 'Avval tushuncha, vocabulary va speaking, keyin ketma-ket mashq' : 'Avval tushuncha, keyin mashq'}</small></div>
        </div>
      </div>

      <button type="button" className="topicBackButton" onClick={onBack}>← Mavzularga qaytish</button>

      <div className="topicTitleHero sequentialHero">
        <div className="topicBigNumber">{topic.topicNo}</div>
        <div>
          <h1>Mavzu tushuntirish</h1>
          <p>{cleanWorkbookLesson ? `${topic.level} daraja · ${topic.title} · sodda tushuntirish, vocabulary, speaking va mashqlar` : `${topic.level} daraja · ${topic.title} · tushunarli izoh, YouTube video dars va ketma-ket mashqlar${showVocabulary ? ' + vocabulary' : ''}${showSpeaking ? ' + speaking' : ''}`}</p>
        </div>
        <div className="topicProgressPill"><b>{topic.topicNo}</b><span>/ {topic.totalTopics || 'mavzu'} dars</span></div>
      </div>

      <article className="sequentialLessonWrap">
        <div className="sequentialLessonTitle">
          <span>Boshlang‘ich mavzu</span>
          <h2>{topic.title}</h2>
          <p>{cleanWorkbookLesson ? 'Mavzu kitob uslubida: ma’no, shakl, ishlatilish, eslatma, misollar, vocabulary va speaking.' : 'Har bir bo‘lim alohida card ko‘rinishida berildi. Yuqoridan pastga qarab ketma-ket o‘qing.'}</p>
        </div>

        {!cleanWorkbookLesson && Array.isArray(topic.exerciseTypes) && topic.exerciseTypes.length > 0 && (
          <section className="lessonStepCard exerciseTypesCard">
            <div className="stepBadge"><span>0</span><i>✅</i></div>
            <div className="stepContent">
              <h3>Mashq turlari</h3>
              <p>Mavzuga mos mashqlar ketma-ket bajariladi. Hozircha barcha mavzular ochiq, foizlar esa o‘zlashtirishni ko‘rsatadi.</p>
              <div className="exerciseTypeChips">
                {topic.exerciseTypes.map(type => <span key={type}>{type}</span>)}
              </div>
            </div>
          </section>
        )}

        {showYoutubeVideo && <YouTubeLessonVideo video={topic.youtubeVideo} topicTitle={topic.title} />}

        <div className="sequentialCards">
          <section className="lessonStepCard meaningCard">
            <div className="stepBadge"><span>1</span><i>📖</i></div>
            <div className="stepContent">
              <h3>Mavzuning ma’nosi</h3>
              <p>{meaning?.text || `${topic.title} mavzusi bo‘yicha asosiy tushuncha.`}</p>
              <div className="miniExampleList">
                {examples.slice(0, 3).map((example, index) => {
                  const ex = splitLearningExample(example);
                  return <div key={`${example}-${index}`}><b>{ex.main}</b>{ex.translation && <span>{ex.translation}</span>}</div>;
                })}
              </div>
            </div>
          </section>

          {keyWords.length > 0 && (
            <section className="lessonStepCard keyWordsStepCard">
              <div className="stepBadge"><span>2</span><i>🔑</i></div>
              <div className="stepContent">
                <h3>Kalit so‘zlar</h3>
                <p>Bu mavzuni tushunish uchun eng kerakli so‘zlar. Chapda inglizcha so‘z, o‘ngda o‘zbekcha ma’nosi berilgan.</p>
                <div className="keyWordGrid">
                  {keyWords.map(item => (
                    <div className="keyWordChip" key={`${topic.id || topic.title}-${item.word}`}>
                      <b>{item.word}</b>
                      <span>{item.meaning}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {formCards.map((card, index) => (
            <section className="lessonStepCard grammarStepCard" key={card.title}>
              <div className="stepBadge"><span>{formStepStart + index}</span><i>{card.icon}</i></div>
              <div className="stepContent">
                <h3>{card.title}</h3>
                <div className="formulaLine">
                  {splitFormulaLines(card.formula).map((line, lineIndex) => (
                    <span key={`${card.title}-formula-${lineIndex}`}>{line}</span>
                  ))}
                </div>
                {card.text && <p>{card.text}</p>}
                {Array.isArray(card.points) && card.points.length > 0 && (
                  <ul className="greenPointList">
                    {card.points.map(point => <li key={point}>{point}</li>)}
                  </ul>
                )}
                {Array.isArray(card.examples) && card.examples.length > 0 && (
                  <div className="miniExampleList splitExamples">
                    {card.examples.map((example, exIndex) => {
                      const ex = splitLearningExample(example);
                      return <div key={`${example}-${exIndex}`}><b>{ex.main}</b>{ex.translation && <span>{ex.translation}</span>}</div>;
                    })}
                  </div>
                )}
              </div>
            </section>
          ))}

          {supportCards.map((part, index) => (
            <section className="lessonStepCard" key={part.heading}>
              <div className="stepBadge"><span>{supportStepStart + index}</span><i>{['🧠', '🔍', '⚠️'][index] || '⭐'}</i></div>
              <div className="stepContent">
                <h3>{part.heading}</h3>
                <p>{part.text}</p>
              </div>
            </section>
          ))}

          <section className="lessonStepCard examplesStepCard">
            <div className="stepBadge"><span>{examplesStepNo}</span><i>📝</i></div>
            <div className="stepContent">
              <h3>{cleanWorkbookLesson ? 'Misollar' : 'Ko‘proq misollar'}</h3>
              {!cleanWorkbookLesson && <p>Har bir gapni o‘qing, tarjima qiling va shu tuzilishga o‘xshash yangi gap tuzing.</p>}
              <div className="numberedExamplesList">
                {examples.map((example, index) => {
                  const ex = splitLearningExample(example);
                  return <div key={`${example}-${index}`}><b>{index + 1}</b><span><strong>{ex.main}</strong>{ex.translation && <> / {ex.translation}</>}</span></div>;
                })}
              </div>
            </div>
          </section>

          {showVocabulary && (
            <section className="lessonStepCard vocabularyStepCard">
              <div className="stepBadge"><span>{examplesStepNo + 1}</span><i>📚</i></div>
              <div className="stepContent">
                <h3>Vocabulary</h3>
                <p>Essential vocabularydan olingan 30 ta asosiy so‘z. Har bir qator bitta so‘zdan iborat.</p>
                <div className="vocabRows">
                  {vocabulary.map(item => (
                    <div className="vocabRow" key={item.id || item.word}>
                      <b>{item.word}</b>
                      <span>{item.meaning}</span>
                      {item.example && <small>{item.example}</small>}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {showSpeaking && <PronunciationSpeakingPractice topic={topic} vocabulary={vocabulary} stepNo={examplesStepNo + 2} onSaved={onSpeakingSaved} />}
        </div>
      </article>

      <div className="topicBottomActions sequentialActions">
        <button type="button" className="ghost" onClick={onBack}>← Mavzularga qaytish</button>
        <button type="button" className="ghost" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>↑ Tepaga chiqish</button>
        <button type="button" className="primary big" onClick={() => { setMode('practice'); scrollPageToTop('smooth'); }}>Mashq bajarish →</button>
      </div>
    </section>
  );
}


function clampPercent(value) {
  const n = Number(value) || 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function TopicProgressRing({ value }) {
  const score = clampPercent(value);
  return <div className="lessonRing" style={{ '--score': score }}><span>{score}%</span></div>;
}

function TopicLessonRow({ topic, isCurrent, onClick }) {
  const score = clampPercent(topic.bestScore);
  const isDone = score >= TOPIC_PASS_SCORE;
  const isLocked = !topic.unlocked;
  const statusText = isLocked ? (topic.scheduleLocked ? 'Reja bo‘yicha yopiq' : 'Hozircha ochiq') : isDone ? 'O‘zlashtirildi' : isCurrent ? 'Joriy dars' : 'Davom ettirish mumkin';
  const metaText = isLocked ? (topic.unlockMessage || 'Yakunlanmagan') : `Eng yaxshi natija: ${score}% · Urinishlar: ${topic.attempts || 0} marta`;

  return (
    <button
      type="button"
      disabled={isLocked}
      className={`lessonRow ${isLocked ? 'locked' : 'open'} ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''}`}
      onClick={onClick}
    >
      <div className="lessonNumber">{topic.topicNo}</div>
      <div className="lessonLockIcon">{isLocked ? '🔒' : isDone ? '✅' : '📘'}</div>
      <div className="lessonInfo">
        <div className="lessonTitleLine">
          <b>{topic.title}</b>
          <span className={`lessonStatus ${isLocked ? 'locked' : isDone ? 'done' : 'current'}`}>{statusText}</span>
        </div>
        <small>{metaText}</small>
      </div>
      <TopicProgressRing value={score} />
      <div className="lessonArrow">›</div>
    </button>
  );
}

function NextLessonsSwiper({ topics, currentTopic, onOpenTopic }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(prev => topics.length ? Math.min(prev, topics.length - 1) : 0);
  }, [topics.length]);

  if (!topics.length) {
    return <div className="emptyLessonRow">Keyingi darslar yo‘q</div>;
  }

  const activeIndex = Math.min(index, topics.length - 1);
  const topic = topics[activeIndex];
  const canPrev = activeIndex > 0;
  const canNext = activeIndex < topics.length - 1;

  return (
    <div className="nextLessonSwiper">
      <div className="lessonSwiperTop">
        <div>
          <b>Keyingi darslar swiper</b>
          <small>Strelka bilan keyingi mavzularni birma-bir ko‘ring.</small>
        </div>
        <div className="lessonSwiperControls">
          <button type="button" className="lessonSwiperArrow" disabled={!canPrev} onClick={() => setIndex(activeIndex - 1)} aria-label="Oldingi dars">‹</button>
          <span>{activeIndex + 1}/{topics.length}</span>
          <button type="button" className="lessonSwiperArrow" disabled={!canNext} onClick={() => setIndex(activeIndex + 1)} aria-label="Keyingi dars">›</button>
        </div>
      </div>

      <div className="lessonSwiperViewport">
        <TopicLessonRow
          topic={topic}
          isCurrent={currentTopic?.id === topic.id}
          onClick={() => topic.unlocked && onOpenTopic(topic)}
        />
      </div>

      <div className="lessonSwiperDots" aria-label="Keyingi darslar indikatorlari">
        {topics.map((item, dotIndex) => (
          <button
            type="button"
            key={item.id}
            className={dotIndex === activeIndex ? 'active' : ''}
            onClick={() => setIndex(dotIndex)}
            aria-label={`${dotIndex + 1}-darsga o‘tish`}
          >
            {dotIndex + 1}
          </button>
        ))}
      </div>
    </div>
  );
}

function getTopicStatus(topic) {
  const score = clampPercent(topic.bestScore);
  if (!topic.unlocked) return { label: topic.scheduleLocked ? 'Reja kuni kutilmoqda' : 'Yopiq mavzu', tone: 'locked', text: topic.unlockMessage || 'Oldingi mavzu 90%+ bo‘lsa ochiladi' };
  if (!topic.attempts) return { label: 'Test topshirilmagan', tone: 'weak', text: 'Hali natija yo‘q — 0%' };
  if (score >= TOPIC_PASS_SCORE) return { label: 'Yaxshi o‘zlashtirilgan', tone: 'good', text: 'Mavzu keyingi bosqich uchun tayyor' };
  if (score >= 50) return { label: 'O‘rtacha', tone: 'mid', text: 'Natijani yaxshilash uchun yana mashq kerak' };
  return { label: 'Sust o‘zlashtirilgan', tone: 'weak', text: 'Bu mavzuni qayta o‘qish tavsiya qilinadi' };
}

function mobileTopicStatus(topic, currentTopic) {
  const score = clampPercent(topic.bestScore);
  if (!topic.unlocked) return { key: 'locked', label: topic.scheduleLocked ? 'Reja kuni' : 'Yopiq', action: 'Yopiq' };
  if (score >= TOPIC_PASS_SCORE) return { key: 'done', label: 'Yakunlangan', action: 'Ko‘rish' };
  if (currentTopic?.id === topic.id) return { key: 'current', label: 'Jarayonda', action: score > 0 ? 'Davom etish' : 'Boshlash' };
  return { key: 'open', label: score > 0 ? 'Jarayonda' : 'Boshlanmagan', action: score > 0 ? 'Davom etish' : 'Boshlash' };
}

function MobileStudentTopicRow({ topic, currentTopic, onOpen, mode = 'topic' }) {
  const score = clampPercent(topic.bestScore);
  const meta = mobileTopicStatus(topic, currentTopic);
  const buttonText = mode === 'test'
    ? (topic.unlocked ? (score >= TOPIC_PASS_SCORE ? 'Testni qayta ishlash' : 'Testni ishlash') : 'Yopiq')
    : meta.action;
  return (
    <div className={`mobileTopicCard ${meta.key}`}>
      <div className={`mobileTopicNumber ${meta.key}`}>{topic.topicNo}</div>
      <div className="mobileTopicBody">
        <div className="mobileTopicHead">
          <div>
            <h4>{topic.title}</h4>
            <p>{!topic.unlocked && topic.unlockMessage ? topic.unlockMessage : (topic.summary || `${topic.level} daraja mavzusi`)}</p>
          </div>
          <span className={`mobileTopicBadge ${meta.key}`}>{meta.label}</span>
        </div>
        <div className="mobileTopicFoot">
          <b>{score}%</b>
          <button type="button" disabled={!topic.unlocked} className={`mobileTopicAction ${meta.key} ${mode === 'test' ? 'testMode' : ''}`} onClick={() => topic.unlocked && onOpen(topic)}>{buttonText}</button>
        </div>
      </div>
    </div>
  );
}

function MobileCertificateCard({ certificate }) {
  return (
    <div className="mobileCertificateCard">
      <div className="mobileCertificateIcon">🏆</div>
      <div className="mobileCertificateBody">
        <h4>{certificate.level} daraja sertifikati</h4>
        <p>{certificate.languageTitle || 'Fan'} muvaffaqiyatli yakunlangan</p>
        <small>Olingan sana: {fmtDate(certificate.createdAt)}</small>
      </div>
      <button type="button" className="mobileCertificateOpen" onClick={() => openCertificate(certificate)}>Ko‘rish</button>
    </div>
  );
}

function normalizeWordGameReview(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[’`ʻ']/g, '')
    .replace(/\s+/g, ' ');
}

function buildWordGameReview(result) {
  const words = Array.isArray(result?.words) ? result.words : [];
  const answers = Array.isArray(result?.answers) ? result.answers : [];
  return words.map((item, idx) => {
    const userAnswer = answers[idx] || '';
    const accepted = [item.answer, ...(item.alternatives || [])].map(normalizeWordGameReview);
    const isCorrect = accepted.includes(normalizeWordGameReview(userAnswer));
    return { ...item, userAnswer, isCorrect };
  });
}

function StudentGameMagazine({ compact = false, mode = 'all' }) {
  const [data, setData] = useState(null);
  const [answers, setAnswers] = useState(['', '', '']);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [timeLeft, setTimeLeft] = useState(15);
  const [finished, setFinished] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const submittedRef = useRef(false);

  async function loadGame() {
    const d = await api('/api/student/game');
    setData(d);
    setAnswers(['', '', '']);
    setCurrentIndex(0);
    setTimeLeft(d?.game?.timePerWord || 15);
    setFinished(!d?.canPlay);
    submittedRef.current = false;
  }

  useEffect(() => { loadGame().catch(err => setMessage(err.message)); }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!data?.canPlay && data?.nextPlayAt) {
      const left = Math.max(0, new Date(data.nextPlayAt).getTime() - now);
      if (left <= 0) loadGame().catch(() => {});
    }
  }, [now, data?.canPlay, data?.nextPlayAt]);

  async function submitGame(finalAnswers = answers) {
    if (submittedRef.current || busy || !data?.canPlay) return;
    submittedRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      const d = await api('/api/student/game/play', { method: 'POST', body: JSON.stringify({ answers: finalAnswers }) });
      setData(d);
      if (typeof d?.coins !== 'undefined') {
        window.dispatchEvent(new CustomEvent('student-coins-updated', { detail: { coins: d.coins } }));
      }
      setFinished(true);
      setMessage(d.message || 'Coin qo‘shildi');
    } catch (err) {
      submittedRef.current = false;
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  function nextWord() {
    const total = data?.game?.words?.length || 3;
    if (currentIndex >= total - 1) {
      setFinished(true);
      submitGame(answers);
      return;
    }
    setCurrentIndex(i => i + 1);
    setTimeLeft(data?.game?.timePerWord || 15);
  }

  function handleAnswerChange(value) {
    setAnswers(prev => prev.map((v, i) => i === currentIndex ? value : v));
  }

  function handleAnswerSubmit(e) {
    e?.preventDefault?.();
    if (!data?.canPlay || busy || finished) return;
    nextWord();
  }

  useEffect(() => {
    if (!data?.canPlay || finished || mode === 'shop') return;
    const timer = setInterval(() => {
      setTimeLeft(prev => {
        // 15 sekund tugaganda o‘yin yoki so‘z avtomatik yangilanmaydi.
        // O‘quvchi faqat "Keyingi so‘z" tugmasi orqali davom etadi.
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [data?.canPlay, finished, currentIndex, mode]);

  async function buyItem(itemId) {
    setBusy(true);
    setMessage('');
    try {
      const result = await api('/api/student/shop/buy', { method: 'POST', body: JSON.stringify({ itemId }) });
      setMessage(result.message || 'Admin javobini kuting');
      if (typeof result?.coins !== 'undefined') {
        window.dispatchEvent(new CustomEvent('student-coins-updated', { detail: { coins: result.coins } }));
      }
      await loadGame();
    } catch (err) {
      setMessage(err.message || 'Sizda Coin yetarlicha emas');
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <section className="gameShopPanel"><div className="mobileEmptyState">O‘yin yuklanmoqda...</div></section>;
  const game = data.game || { words: [], timePerWord: 15 };
  const words = game.words || [];
  const activeWord = words[currentIndex] || words[0] || {};
  const showGame = mode === 'all' || mode === 'game';
  const showShop = mode === 'all' || mode === 'shop';
  const progressWidth = Math.max(0, Math.min(100, (timeLeft / (game.timePerWord || 15)) * 100));
  const serverRemaining = Number(data.remainingMs || 0);
  const nextPlayTime = data.nextPlayAt ? new Date(data.nextPlayAt).getTime() : 0;
  const cooldownRemainingMs = nextPlayTime ? Math.max(0, nextPlayTime - now) : Math.max(0, serverRemaining);
  const cooldownSeconds = Math.max(0, Math.ceil(cooldownRemainingMs / 1000));
  const cooldownHours = Math.floor(cooldownSeconds / 3600);
  const cooldownMinutes = Math.floor((cooldownSeconds % 3600) / 60);
  const cooldownOnlySeconds = cooldownSeconds % 60;
  const cooldownText = `${String(cooldownHours).padStart(2, '0')}:${String(cooldownMinutes).padStart(2, '0')}:${String(cooldownOnlySeconds).padStart(2, '0')}`;

  return (
    <section className={`gameShopPanel ${compact ? 'compact' : ''} ${mode === 'shop' ? 'shopOnly' : ''}`}>
      {showGame && <>
        <div className="gameHeroCard wordGameHero">
          <div>
            <span className="gameEyebrow">🎮 Daily Word Game</span>
            <h2>Tarjimasini yozing</h2>
          </div>
        </div>

        <div className="gameCard wordGameCard">
          <div className="gameCardHead">
            <div><h3>Bugungi so‘z o‘yini</h3><p>{data.canPlay ? `${currentIndex + 1}/3 so‘z` : 'Bugungi imkoniyat ishlatildi'}</p></div>
            <span className={data.canPlay ? 'gameOpenBadge' : 'gameClosedBadge'}>{data.canPlay ? `${timeLeft}s` : `Qolgan vaqt ${cooldownText}`}</span>
          </div>

          {data.canPlay && !finished ? <form className="wordGameBox" onSubmit={handleAnswerSubmit}>
            <div className="wordTimerTrack"><span style={{ width: `${progressWidth}%` }} /></div>
            <div className="wordQuestionCard">
              <small>Inglizcha so‘z</small>
              <strong>{activeWord.word}</strong>
            </div>
            <input
              autoFocus
              className="wordAnswerInput"
              value={answers[currentIndex] || ''}
              onChange={e => handleAnswerChange(e.target.value)}
              placeholder="O‘zbekcha tarjimasini yozing..."
              disabled={busy}
            />
            <button type="submit" className="primary gamePlayButton" disabled={busy}>Keyingi so‘z</button>
          </form> : <div className="wordGameFinished">
            <div className="shopItemIcon">🏁</div>
            <h3>{data.result ? `${data.result.correct}/3 to‘g‘ri` : (data.wordsFinished ? 'Yangi so‘zlar tugadi' : 'O‘yin yakunlandi')}</h3>
            <p>{data.result ? `+${data.result.coins} coin qo‘shildi` : (data.wordsFinished ? 'Bu account uchun barcha so‘zlar ishlatildi. Yangi so‘z qo‘shilganda davom etadi.' : `Yana o‘ynash uchun qolgan vaqt: ${cooldownText}`)}</p>
          </div>}

          {data.result && <div className="gameResultBox"><b>{data.result.correct}/3 to‘g‘ri</b><span>+{data.result.coins} coin</span></div>}
          {data.result && (
            <div className="wordGameReviewBox">
              <h4>Javoblar natijasi</h4>
              {buildWordGameReview(data.result).map((item, idx) => (
                <div className={`wordReviewRow ${item.isCorrect ? 'correct' : 'wrong'}`} key={`${item.id || idx}_${idx}`}>
                  <div className="wordReviewStatus">{item.isCorrect ? '✅' : '❌'}</div>
                  <div className="wordReviewBody">
                    <b>{item.word}</b>
                    <span>Siz yozdingiz: <strong>{item.userAnswer || '—'}</strong></span>
                    {!item.isCorrect && <small>To‘g‘ri javob: {item.answer}</small>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {message && <div className="gameMessage">{message}</div>}
        </div>
      </>}

      {showShop && <div className="magazineCard">
        <div className="gameCardHead"><div><h3>Magazine</h3><p>Coin yig‘ing va sovg‘a sotib oling.</p></div><span>Buy Now</span></div>
        <div className="shopGrid">
          {(data.shopItems || []).map(item => (
            <div className="shopItemCard" key={item.id}>
              <div className="shopItemIcon">{item.icon}</div>
              <b>{item.title}</b>
              <span className="shopPrice"><i className="coinPicture smallCoin" aria-hidden="true" />{item.price} coin</span>
              <button type="button" disabled={busy} onClick={() => buyItem(item.id)}>Buy Now</button>
            </div>
          ))}
        </div>
        {mode === 'shop' && message && <div className="gameMessage">{message}</div>}
      </div>}
    </section>
  );
}

function StudentCoinBadge() {
  const [coins, setCoins] = useState(0);
  useEffect(() => {
    let alive = true;
    api('/api/student/game').then(d => { if (alive) setCoins(d.coins || 0); }).catch(() => {});
    const onFocus = () => api('/api/student/game').then(d => { if (alive) setCoins(d.coins || 0); }).catch(() => {});
    const onCoinsUpdated = (event) => {
      if (!alive) return;
      const updatedCoins = Number(event?.detail?.coins);
      if (Number.isFinite(updatedCoins)) setCoins(updatedCoins);
      else onFocus();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('student-coins-updated', onCoinsUpdated);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('student-coins-updated', onCoinsUpdated);
    };
  }, []);
  return <div className="studentCoinPill"><span className="coinPicture" aria-hidden="true" /><b>{coins}</b><small>coin</small></div>;
}

function FixedDailyGameButton({ onClick }) {
  return (
    <button type="button" className="fixedDailyGameButton" onClick={onClick} aria-label="O‘yin oynash">
      <span className="fixedGameImage">🎮</span>
      <div><b>So‘z o‘yini</b></div>
    </button>
  );
}

function AdminShopOrdersPanel() {
  const [orders, setOrders] = useState([]);
  const [message, setMessage] = useState('');
  async function loadOrders() {
    const d = await api('/api/admin/shop-orders');
    setOrders(d.orders || []);
  }
  useEffect(() => { loadOrders().catch(err => setMessage(err.message)); }, []);
  return (
    <div className="adminTabPane">
      <div className="adminTabHeader"><div><span className="eyebrow miniEyebrow">Magazine</span><h2>O‘quvchi buyurtmalari</h2><p className="muted">Buy Now bosilganda shu yerga “account egasi sotib oldi” deb keladi.</p></div><button type="button" className="ghost small" onClick={loadOrders}>Yangilash</button></div>
      <section className="card shopOrdersCard">
        <div className="shopOrdersList">
          {orders.map(order => (
            <div className="shopOrderRow" key={order.id}>
              <div className="shopOrderIcon">{order.itemIcon || '🎁'}</div>
              <div><b>{order.fullName || order.username} sotib oldi</b><span>{order.itemTitle} · {order.price} coin · {fmtDateTime(order.createdAt)}</span></div>
              <em>{order.status === 'pending' ? 'Admin javobini kutmoqda' : order.status}</em>
            </div>
          ))}
          {!orders.length && <p className="empty">Hali buyurtma yo‘q</p>}
        </div>
        {message && <p className="empty">{message}</p>}
      </section>
    </div>
  );
}

function MobileStudentDashboard({ user, onLogout, content, progress, subject, setSubject, level, selectLevel, topics, currentTopic, overallPercent, completedCount, totalTopics, openTopic, openFinal, finalUnlocked }) {
  const [tab, setTab] = useState('topics');
  const [mobileProfileOpen, setMobileProfileOpen] = useState(false);
  const currentSubjectTitle = content?.subjects?.find(s => s.id === subject)?.title || 'Fan';
  const openedLevels = content.levels || [];
  const certificates = progress.certificates || [];
  const studentBrand = panelBrand(user, { subtitle: 'ENGLISH Mock' });
  const levelAccess = progress.access?.[subject] || {};
  const completedTopics = topics.filter(t => clampPercent(t.bestScore) >= TOPIC_PASS_SCORE).length;
  const mobileSortedStatsTopics = useMemo(() => {
    return [...topics].sort((a, b) => {
      const scoreDiff = clampPercent(a.bestScore) - clampPercent(b.bestScore);
      if (scoreDiff !== 0) return scoreDiff;
      return Number(a.topicNo) - Number(b.topicNo);
    });
  }, [topics]);
  const mobileWeakTopic = mobileSortedStatsTopics.find(topic => topic.unlocked && clampPercent(topic.bestScore) < TOPIC_PASS_SCORE);

  return (
    <main className="mobileStudentPage">
      <section className="mobileStudentHeader">
        <div className="mobileBrandBlock">
          <BrandLogo brand={studentBrand} className="mobileBrandLogo" alt="Markaz logo" />
          <div>
            <b>{studentBrand.name}</b>
            <span>{studentBrand.subtitle}</span>
          </div>
        </div>
        <div className="mobileProfileDropdownWrap">
          <button type="button" className={`mobileStudentProfile ${mobileProfileOpen ? 'open' : ''}`} onClick={() => setMobileProfileOpen(v => !v)}>
            <div className="mobileStudentAvatar">{(user?.fullName || user?.username || 'U').slice(0, 1).toUpperCase()}</div>
            <div>
              <b>{user?.fullName || user?.username || 'O‘quvchi'}</b>
              <span>{level} daraja</span>
            </div>
            <em>⌄</em>
          </button>
          {mobileProfileOpen && (
            <div className="studentProfileDropdown mobile">
              <button type="button" onClick={() => safeLogout(onLogout)}>
                <span>🚪</span>
                <div><b>Chiqish</b><small>Accountdan chiqish</small></div>
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="mobileStudentHero">
        <div>
          <h1>O‘quvchi paneli</h1>
          <p>Telefon uchun sodda ko‘rinish: mavzular, test, foiz va sertifikatlar.</p>
        </div>
      </section>

      <section className="mobileSummaryGrid">
        <div className="mobileSummaryCard">
          <div className="mobileSummaryIcon">🎓</div>
          <div>
            <span>Daraja</span>
            <strong>{level}</strong>
          </div>
        </div>
        <div className="mobileSummaryCard">
          <div className="mobileSummaryIcon">📈</div>
          <div>
            <span>Foiz</span>
            <strong>{overallPercent}%</strong>
          </div>
        </div>
        <div className="mobileSummaryCard">
          <div className="mobileSummaryIcon">📜</div>
          <div>
            <span>Sertifikat</span>
            <strong>{certificates.length} ta</strong>
          </div>
        </div>
      </section>

      <section className="mobileLevelStripWrap">
        <div className="mobileLevelStripTitle">
          <b>{currentSubjectTitle}</b>
          <span>Darajani tanlang</span>
        </div>
        <div className="mobileLevelStrip">
          {openedLevels.map(lv => (
            <button key={lv} type="button" className={`mobileLevelPill ${level === lv ? 'active' : ''} ${levelAccess[lv] ? 'open' : 'locked'}`} onClick={() => selectLevel(lv)}>
              {lv}{STUDENT_NOT_READY_LEVELS.includes(lv) && !levelAccess[lv] ? ' · Ishlanmoqda' : ''}
            </button>
          ))}
        </div>
      </section>

      <section className="mobileTabBody">
        {tab === 'topics' && (
          <div className="mobileSectionCard">
            <div className="mobileSectionHead">
              <h3>Mavzular</h3>
              <span>{level} daraja</span>
            </div>
            <div className="mobileTopicList">
              {topics.map(topic => <MobileStudentTopicRow key={topic.id} topic={topic} currentTopic={currentTopic} onOpen={openTopic} mode="topic" />)}
            </div>
          </div>
        )}

        {tab === 'tests' && (
          <div className="mobileSectionCard">
            <div className="mobileSectionHead">
              <h3>Testlar</h3>
              <span>{completedCount}/{totalTopics}</span>
            </div>
            <div className="mobileTopicList">
              {topics.map(topic => <MobileStudentTopicRow key={topic.id} topic={topic} currentTopic={currentTopic} onOpen={openTopic} mode="test" />)}
            </div>
            <div className="mobileFinalTestCard">
              <div>
                <b>Yakuniy test</b>
                <p>{totalTopics} ta mavzudan kamida 90% olgach ochiladi.</p>
              </div>
              <button type="button" className="mobileFinalButton" disabled={!finalUnlocked} onClick={openFinal}>{finalUnlocked ? 'Yakuniy testni ochish' : 'Hali yopiq'}</button>
            </div>
          </div>
        )}

        {tab === 'stats' && (
          <div className="mobileSectionCard">
            <div className="mobileSectionHead">
              <h3>Foiz va daraja</h3>
              <span>{overallPercent}%</span>
            </div>
            <div className="mobileStatsLevelBox">
              <b>Darajalar</b>
              <div className="mobileStatsLevelGrid">
                {openedLevels.map(lv => {
                  const open = !!levelAccess[lv];
                  return (
                    <button key={lv} type="button" disabled={!open} className={`mobileStatsLevelBtn ${level === lv ? 'active' : ''} ${open ? 'open' : 'locked'}`} onClick={() => open && selectLevel(lv)}>
                      {lv}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="mobileProgressCardLarge">
              <div className="mobileProgressTop">
                <div>
                  <b>{level} daraja o‘zlashtirish</b>
                  <p>{completedTopics}/{totalTopics} mavzu yakunlangan</p>
                </div>
                <strong>{overallPercent}%</strong>
              </div>
              <div className="mobileProgressBar"><i style={{ width: `${overallPercent}%` }} /></div>
            </div>
            <div className="mobileWeakFocusCard">
              <span>Eng sust mavzu</span>
              <b>{mobileWeakTopic ? `${mobileWeakTopic.topicNo}. ${mobileWeakTopic.title}` : 'Sust mavzu yo‘q'}</b>
              <small>{mobileWeakTopic ? `${clampPercent(mobileWeakTopic.bestScore)}% · ${mobileTopicStatus(mobileWeakTopic, currentTopic).label}` : `${level} darajada 90% dan past ochiq mavzu topilmadi`}</small>
            </div>
            <div className="mobileStatsList">
              {mobileSortedStatsTopics.map(topic => (
                <button type="button" key={topic.id} disabled={!topic.unlocked} className={`mobileStatRow ${clampPercent(topic.bestScore) < TOPIC_PASS_SCORE ? 'weak' : 'good'}`} onClick={() => topic.unlocked && openTopic(topic)}>
                  <div>
                    <b>{topic.topicNo}. {topic.title}</b>
                    <span>{mobileTopicStatus(topic, currentTopic).label}</span>
                  </div>
                  <strong>{clampPercent(topic.bestScore)}%</strong>
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === 'game' && (
          <div className="mobileSectionCard">
            <StudentGameMagazine compact mode="game" />
          </div>
        )}

        {tab === 'magazine' && (
          <div className="mobileSectionCard">
            <StudentGameMagazine compact mode="shop" />
          </div>
        )}

        {tab === 'certs' && (
          <div className="mobileSectionCard">
            <div className="mobileSectionHead">
              <h3>Sertifikatlar</h3>
              <span>{certificates.length} ta</span>
            </div>
            {certificates.length ? (
              <div className="mobileCertificateList">
                {certificates.map(certificate => <MobileCertificateCard key={certificate.id} certificate={certificate} />)}
              </div>
            ) : (
              <div className="mobileEmptyState">Hali sertifikat yo‘q</div>
            )}
          </div>
        )}
      </section>

      <nav className="mobileBottomNav">
        <button type="button" className={tab === 'topics' ? 'active' : ''} onClick={() => setTab('topics')}><span>📚</span><b>Mavzular</b></button>
        <button type="button" className={tab === 'tests' ? 'active' : ''} onClick={() => setTab('tests')}><span>📝</span><b>Test</b></button>
        <button type="button" className={tab === 'stats' ? 'active' : ''} onClick={() => setTab('stats')}><span>📈</span><b>Foiz</b></button>
        <button type="button" className={tab === 'game' ? 'active' : ''} onClick={() => setTab('game')}><span>🎮</span><b>O‘yin</b></button>
        <button type="button" className={tab === 'magazine' ? 'active' : ''} onClick={() => setTab('magazine')}><span>🛍️</span><b>Magazine</b></button>
        <button type="button" className={tab === 'certs' ? 'active' : ''} onClick={() => setTab('certs')}><span>🏅</span><b>Sertifikat</b></button>
      </nav>
    </main>
  );
}

function desktopTopicMeta(topic, currentTopic) {
  const score = clampPercent(topic.bestScore);
  const isLocked = !topic.unlocked;
  if (isLocked) return { status: topic.scheduleLocked ? 'Reja kuni' : 'Yopiq', tone: 'locked', action: 'Yopiq' };
  if (score >= TOPIC_PASS_SCORE) return { status: 'Yakunlangan', tone: 'done', action: 'Natijani ko‘rish' };
  if (currentTopic?.id === topic.id) return { status: 'Jarayonda', tone: 'current', action: 'Davom etish' };
  return { status: 'Boshlanmagan', tone: 'idle', action: 'Boshlash' };
}

function DesktopTopicRow({ topic, currentTopic, onOpen }) {
  const meta = desktopTopicMeta(topic, currentTopic);
  const score = clampPercent(topic.bestScore);
  return (
    <div className={`desktopTopicRow ${meta.tone}`}>
      <div className={`desktopTopicNumber ${meta.tone}`}>{topic.topicNo}</div>
      <div className="desktopTopicInfo">
        <b>{topic.title}</b>
        <span>{!topic.unlocked && topic.unlockMessage ? topic.unlockMessage : (topic.summary || `${topic.level} daraja mavzusi`)}</span>
      </div>
      <span className={`desktopTopicStatus ${meta.tone}`}>{meta.status}</span>
      <strong className="desktopTopicScore">{score}%</strong>
      <button type="button" disabled={!topic.unlocked} className={`desktopTopicAction ${meta.tone}`} onClick={() => topic.unlocked && onOpen(topic)}>{meta.action}</button>
    </div>
  );
}

function DesktopStudentDashboard({ user, onLogout, content, progress, activeTab, setActiveTab, subject, level, selectLevel, topics, currentTopic, completedCount, totalTopics, overallPercent, openTopic, openFinal, finalUnlocked }) {
  const selectedSubjectTitle = content?.subjects?.find(s => s.id === subject)?.title || 'Ingliz tili';
  const speakingSummary = progress?.speakingSummary || {};
  const certificates = progress?.certificates || [];
  const levelAccess = progress?.access?.[subject] || {};
  const latestCertificates = certificates.slice(-3).reverse();
  const recentTopicResults = topics.filter(t => clampPercent(t.bestScore) > 0).sort((a, b) => b.topicNo - a.topicNo).slice(0, 3);
  const recentActivities = [
    ...recentTopicResults.map(t => ({ icon: '✅', title: `“${t.title}” mavzusi yakunlandi`, desc: `${clampPercent(t.bestScore)}% natija bilan`, time: 'Yaqinda' })),
    ...(speakingSummary.checkedWords ? [{ icon: '🎤', title: 'Speaking mashqi bajarildi', desc: `${speakingSummary.checkedWords}/${speakingSummary.totalWords || 0} ta so‘z tekshirildi`, time: 'Bugun' }] : []),
    ...(certificates.length ? [{ icon: '🏅', title: 'Sertifikat olindi', desc: `${certificates[certificates.length - 1].level} daraja sertifikati`, time: fmtDate(certificates[certificates.length - 1].createdAt) }] : [])
  ].slice(0, 4);
  const studentDisplayName = user?.fullName || user?.username || 'O‘quvchi';
  const studentInitials = studentDisplayName.split(/\s+/).filter(Boolean).map(part => part[0]).join('').slice(0, 2).toUpperCase() || 'ST';
  const studentBrand = panelBrand(user, { subtitle: 'ENGLISH Mock' });
  const studentNav = [
    { id: 'lessons', icon: '📚', title: 'Darslar', desc: `${topics.length || 0} ta mavzu` },
    { id: 'stats', icon: '📈', title: 'Statistika', desc: `${overallPercent}% umumiy progress` },
    { id: 'achievements', icon: '🏆', title: 'Yutuqlar', desc: `${certificates.length} ta sertifikat` },
    { id: 'magazine', icon: '🛍️', title: 'Magazine', desc: 'Sovg‘alar do‘koni' },
    { id: 'reminders', icon: '🔔', title: 'Eslatmalar', desc: 'Qoidalar va tavsiyalar' },
    { id: 'settings', icon: '⚙️', title: 'Sozlamalar', desc: 'Profil va account' }
  ];

  return (
    <main className="desktopStudentPage">
      <FixedDailyGameButton onClick={() => { setActiveTab('game'); scrollPageToTop('smooth'); }} />
      <aside className="desktopStudentSidebarShell accountSidebar studentAccountSidebar">
        <div className="accountSidebarBrand desktopStudentBrand">
          <BrandLogo brand={studentBrand} className="accountBrandMark desktopStudentBrandIcon" alt="Markaz logo" />
          <div>
            <b>{studentBrand.name}</b>
            <span>{studentBrand.subtitle}</span>
          </div>
          <em className="accountSidebarBadge">STUDENT</em>
        </div>

        <div className="accountSidebarProfile">
          <strong>{studentInitials}</strong>
          <div>
            <b>{studentDisplayName}</b>
            <span>{selectedSubjectTitle} · {level}</span>
          </div>
        </div>

        <div className="accountSidebarMetrics">
          <div><span>Progress</span><b>{overallPercent}%</b></div>
          <div><span>Darslar</span><b>{completedCount}/{totalTopics}</b></div>
        </div>

        <div className="desktopStudentNav accountSidebarNav">
          {studentNav.map(item => (
            <button type="button" key={item.id} className={activeTab === item.id ? 'active' : ''} onClick={() => { setActiveTab(item.id); scrollPageToTop('smooth'); }}>
              <span>{item.icon}</span>
              <div><b>{item.title}</b><small>{item.desc}</small></div>
            </button>
          ))}
        </div>

        <div className="accountSidebarStatus">
          <span>✓</span>
          <div><b>Darslarga kirish</b><small>Darslar, testlar va sertifikatlar nazoratda</small></div>
        </div>

        <button type="button" className="sidebarLogoutBtn desktopSidebarLogout accountSidebarLogout" onClick={() => safeLogout(onLogout)}>
          <span>↩</span>
          <div><b>Chiqish</b><small>Accountdan chiqish</small></div>
        </button>
      </aside>

      <section className="desktopStudentMain">
        <div className="desktopStudentTopbar">
          <div>
            <h1>O‘quvchi paneli</h1>
            <p>Darslar va progress nazorati</p>
          </div>
          <div className="desktopStudentTopbarRight">
            <button type="button" className="desktopBellButton">!<i /></button>
            <StudentCoinBadge />
          </div>
        </div>

        <div className="desktopSummaryCards">
          <article className="desktopSummaryCard"><div className="desktopSummaryIcon">📈</div><div><span>Umumiy progress</span><strong>{overallPercent}%</strong><small>{level} daraja</small><div className="desktopMiniBar"><i style={{ width: `${overallPercent}%` }} /></div></div></article>
          <article className="desktopSummaryCard"><div className="desktopSummaryIcon">🎙️</div><div><span>Speaking</span><strong>{speakingSummary.percent || 0}%</strong><small>Talaffuz aniqligi</small></div></article>
          <article className="desktopSummaryCard"><div className="desktopSummaryIcon">🎓</div><div><span>Tugatilgan mavzular</span><strong>{completedCount} / {totalTopics}</strong><small>Barcha mavzular yakunlangan</small></div></article>
          <article className="desktopSummaryCard"><div className="desktopSummaryIcon">📜</div><div><span>Sertifikatlar</span><strong>{certificates.length}</strong><small>Olingan sertifikatlar</small></div></article>
        </div>

        {activeTab === 'lessons' && (
          <div className="desktopLessonsGrid">
            <div className="desktopLessonsMainCol">
              <section className="desktopPanelCard desktopCourseCard">
                <h2>Mening kursim</h2>
                <div className="desktopCourseInner">
                  <div className="desktopCourseBadge">{selectedSubjectTitle.slice(0, 2).toUpperCase()}</div>
                  <div className="desktopCourseInfo">
                    <b>{selectedSubjectTitle}</b>
                    <span>Boshlang‘ich daraja</span>
                    <em>{level}</em>
                  </div>
                  <div className="desktopCourseProgress">
                    <span>Kurs progressi</span>
                    <div className="desktopMiniBar large"><i style={{ width: `${overallPercent}%` }} /></div>
                    <small>{completedCount} / {totalTopics} mavzu yakunlangan</small>
                  </div>
                  <strong className="desktopCoursePercent">{overallPercent}%</strong>
                </div>
              </section>

              <section className="desktopPanelCard desktopTopicsPanel">
                <div className="desktopPanelHead">
                  <h2>Darslar yo‘li ({level})</h2>
                  <div className="desktopLevelChooser">
                    {content.levels.map(lv => <button key={lv} type="button" className={`desktopLevelTab ${level === lv ? 'active' : ''} ${levelAccess[lv] ? 'open' : 'locked'}`} onClick={() => selectLevel(lv)}>{lv}{STUDENT_NOT_READY_LEVELS.includes(lv) && !levelAccess[lv] ? ' · Ishlanmoqda' : ''}</button>)}
                  </div>
                </div>
                <div className="desktopTopicsList">
                  {topics.map(topic => <DesktopTopicRow key={topic.id} topic={topic} currentTopic={currentTopic} onOpen={openTopic} />)}
                </div>
                <div className="desktopTopicsFooter">
                  <span>Barcha {totalTopics} ta mavzu</span>
                  <button type="button" className="desktopFinalTestButton" disabled={!finalUnlocked} onClick={openFinal}>{finalUnlocked ? 'Yakuniy testni ochish' : 'Yakuniy test yopiq'}</button>
                </div>
              </section>
            </div>

            <div className="desktopLessonsSideCol">
              <section className="desktopPanelCard desktopSpeakingCard">
                <div className="desktopPanelHead compact"><h2>Speaking statistikasi</h2><span>Bu hafta</span></div>
                <div className="desktopSpeakingInner">
                  <div className="desktopSpeakingRing" style={{ '--value': `${speakingSummary.percent || 0}%` }}>
                    <div><strong>{speakingSummary.percent || 0}%</strong><span>Talaffuz aniqligi</span></div>
                  </div>
                  <div className="desktopSpeakingStats">
                    <div><b>{speakingSummary.checkedWords || 0} / {speakingSummary.totalWords || 0} so‘z</b><span>Mashq qilingan so‘zlar</span></div>
                    <div><b>{speakingSummary.attempts || 0}</b><span>Mashq sessiyalari</span></div>
                  </div>
                </div>
              </section>

              <section className="desktopPanelCard desktopActivityCard">
                <h2>Oxirgi faoliyat</h2>
                <div className="desktopActivityList">
                  {recentActivities.length ? recentActivities.map((item, idx) => (
                    <div key={idx} className="desktopActivityItem"><span>{item.icon}</span><div><b>{item.title}</b><small>{item.desc}</small></div><em>{item.time}</em></div>
                  )) : <div className="desktopEmptyTiny">Faoliyat hali yo‘q</div>}
                </div>
              </section>

              <section className="desktopPanelCard desktopCertificateGoal">
                <h2>Sertifikat maqsadi</h2>
                <div className="desktopCertificateGoalInner">
                  <div className="desktopGoalIcon">🏆</div>
                  <div className="desktopGoalText"><p>Barcha {totalTopics} ta mavzuni yakunlang va yakuniy testdan o‘ting.</p></div>
                  <div className="desktopGoalCount"><strong>{completedCount} / {totalTopics}</strong><span>Mavzular yakunlangan</span></div>
                </div>
                <div className="desktopMiniBar large"><i style={{ width: `${overallPercent}%` }} /></div>
              </section>
            </div>
          </div>
        )}

        {activeTab === 'stats' && <StudentStatsPanel topics={topics} completedCount={completedCount} totalTopics={totalTopics} overallPercent={overallPercent} speakingSummary={speakingSummary} onOpenTopic={openTopic} content={content} progress={progress} subject={subject} level={level} selectLevel={selectLevel} />}

        {activeTab === 'achievements' && (
          <section className="desktopPanelCard desktopCertificatesPanel">
            <div className="desktopPanelHead"><h2>Sertifikatlar</h2><span>{certificates.length} ta</span></div>
            {latestCertificates.length ? latestCertificates.map(c => <CertificatePreview key={c.id} certificate={c} compact />) : <div className="desktopEmptyTiny">Hali sertifikat yo‘q</div>}
          </section>
        )}

        {activeTab === 'game' && <StudentGameMagazine mode="game" />}

        {activeTab === 'magazine' && <StudentGameMagazine mode="shop" />}

        {activeTab === 'reminders' && <StudentRemindersPanel topics={topics} completedCount={completedCount} totalTopics={totalTopics} overallPercent={overallPercent} speakingSummary={speakingSummary} onOpenTopic={openTopic} />}

        {activeTab === 'settings' && (
          <section className="desktopPanelCard desktopSettingsPanel">
            <div className="desktopPanelHead"><h2>Sozlamalar</h2><span>O‘quvchi profili</span></div>
            <div className="desktopSettingsGrid">
              <div><span>Ism</span><b>{user?.fullName || user?.username}</b></div>
              <div><span>Fan</span><b>{selectedSubjectTitle}</b></div>
              <div><span>Joriy daraja</span><b>{level}</b></div>
              <div><span>Umumiy foiz</span><b>{overallPercent}%</b></div>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

function StudentStatsPanel({ topics, completedCount, totalTopics, overallPercent, speakingSummary, onOpenTopic, content, progress, subject, level, selectLevel }) {
  const levels = content?.levels || [];
  const levelAccess = progress?.access?.[subject] || {};
  const selectedLevelTitle = level || 'Beginner';
  const sortedTopics = useMemo(() => {
    return [...topics].sort((a, b) => {
      const scoreDiff = clampPercent(a.bestScore) - clampPercent(b.bestScore);
      if (scoreDiff !== 0) return scoreDiff;
      return Number(a.topicNo) - Number(b.topicNo);
    });
  }, [topics]);

  const weakTopicList = sortedTopics.filter(topic => topic.unlocked && clampPercent(topic.bestScore) < TOPIC_PASS_SCORE);
  const weakTopics = weakTopicList.length;
  const attemptedTopics = topics.filter(topic => Number(topic.attempts || 0) > 0).length;
  const weakestTopic = weakTopicList[0] || sortedTopics.find(topic => clampPercent(topic.bestScore) < TOPIC_PASS_SCORE) || sortedTopics[0];

  return (
    <section className="statsPanel">
      <div className="statsHeroCard">
        <div>
          <span className="eyebrow">Statistika</span>
          <h2>Mavzular bo‘yicha o‘zlashtirish</h2>
          <p>Past foiz olgan yoki hali test topshirmagan mavzular tepada turadi. Shu mavzularni qayta o‘qib mustahkamlang.</p>
        </div>
        <div className="statsHeroRings">
          <div className="statsHeroRing">
            <TopicProgressRing value={overallPercent} />
            <span>umumiy</span>
          </div>
          <div className="statsHeroRing speakingHeroRing">
            <TopicProgressRing value={speakingSummary?.percent || 0} />
            <span>speaking</span>
          </div>
        </div>
      </div>

      <div className="statsLevelPanel">
        <div>
          <h3>Darajalar</h3>
          <p>Darajani tanlang, pastdagi ro‘yxatda shu darajadagi sust mavzular ko‘rinadi.</p>
        </div>
        <div className="statsLevelButtons">
          {levels.map(lv => {
            const open = !!levelAccess[lv];
            return (
              <button
                key={lv}
                type="button"
                disabled={!open}
                className={`statsLevelButton ${selectedLevelTitle === lv ? 'active' : ''} ${open ? 'open' : 'locked'}`}
                onClick={() => open && selectLevel?.(lv)}
              >
                <b>{lv}</b>
                <span>{open ? 'Ko‘rish' : 'Yopiq'}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="statsSummaryGrid">
        <div className="statsSummaryCard weak">
          <span>Qayta ishlash kerak</span>
          <b>{weakTopics}</b>
          <small>90% dan past mavzular</small>
        </div>
        <div className="statsSummaryCard mid">
          <span>Test topshirilgan</span>
          <b>{attemptedTopics}</b>
          <small>{totalTopics} ta mavzudan</small>
        </div>
        <div className="statsSummaryCard good">
          <span>O‘zlashtirilgan</span>
          <b>{completedCount}</b>
          <small>90%+ olgan mavzular</small>
        </div>
        <div className="statsSummaryCard focus">
          <span>Eng birinchi ko‘rish kerak</span>
          <b>{weakestTopic ? `${clampPercent(weakestTopic.bestScore)}%` : '0%'}</b>
          <small>{weakestTopic?.title || 'Mavzu yo‘q'}</small>
        </div>
        <div className="statsSummaryCard speakingStatCard">
          <span>Speaking</span>
          <b>{speakingSummary?.percent || 0}%</b>
          <small>{speakingSummary?.checkedWords || 0}/{speakingSummary?.totalWords || 0} ta aytilgan · {speakingSummary?.passedWords || 0} ta 75%+</small>
        </div>
      </div>

      <div className="statsTopicPanel">
        <div className="sectionHead statsHead">
          <div>
            <h2>{selectedLevelTitle} darajadagi sust mavzular</h2>
            <p>Ro‘yxat foiz bo‘yicha o‘sish tartibida: 0%, 20%, 50%, 90%... Eng past natijadan boshlanadi.</p>
          </div>
          <b className="countBadge">{overallPercent}%</b>
        </div>

        {weakTopics === 0 && (
          <div className="statsWeakNotice good">
            <b>Zo‘r natija!</b>
            <span>{selectedLevelTitle} darajada 90% dan past ochiq mavzu topilmadi.</span>
          </div>
        )}

        <div className="statsTopicRows">
          {sortedTopics.map(topic => {
            const score = clampPercent(topic.bestScore);
            const status = getTopicStatus(topic);
            return (
              <button
                type="button"
                key={topic.id}
                disabled={!topic.unlocked}
                className={`statsTopicRow ${status.tone}`}
                onClick={() => topic.unlocked && onOpenTopic(topic)}
              >
                <div className="statsTopicNumber">{topic.topicNo}</div>
                <div className="statsTopicInfo">
                  <div>
                    <b>{topic.title}</b>
                    <span className={`statsStatusBadge ${status.tone}`}>{status.label}</span>
                  </div>
                  <small>{status.text} · Urinishlar: {topic.attempts || 0} marta</small>
                  <small className="speakingTopicHint">🎤 Speaking: {topic.speakingScore || 0}% · {topic.speakingCheckedWords || 0}/{topic.speakingTotalWords || 30} so‘z</small>
                </div>
                <div className="statsPercentBlock">
                  <TopicProgressRing value={score} />
                  <strong>{score}%</strong>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}


function StudentRemindersPanel({ topics, completedCount, totalTopics, overallPercent, onOpenTopic }) {
  const weakTopics = useMemo(() => {
    return [...topics]
      .filter(topic => topic.unlocked && clampPercent(topic.bestScore) < TOPIC_PASS_SCORE)
      .sort((a, b) => {
        const scoreDiff = clampPercent(a.bestScore) - clampPercent(b.bestScore);
        if (scoreDiff !== 0) return scoreDiff;
        return Number(a.topicNo) - Number(b.topicNo);
      })
      .slice(0, 5);
  }, [topics]);

  const guideSteps = [
    {
      no: 1,
      icon: '🔐',
      title: 'Login bilan kiring',
      text: 'Admin bergan login va parol orqali kiring. Account faqat bitta qurilmada ishlaydi, boshqa qurilmadan kirilsa eski sessiya yopiladi.'
    },
    {
      no: 2,
      icon: '📚',
      title: 'Darslarni ketma-ket o‘qing',
      text: 'Mavzular tartib bilan ochiladi. Har bir darsda avval tushuntirishni o‘qing, misollarni ko‘ring, keyin mashqqa o‘ting.'
    },
    {
      no: 3,
      icon: '🎧',
      title: 'Vocabulary va talaffuzni ishlang',
      text: 'Til fanlarida vocabulary so‘zlarini yodlang, eshiting va mikrofon orqali talaffuzingizni tekshiring.'
    },
    {
      no: 4,
      icon: '📝',
      title: 'Mashq bajarish tugmasini bosing',
      text: 'Mashqda avval tanlash savollari, til fanlarida esa keyin yozma tarjima mashqi chiqadi. Telefon versiyada savollar swiper ko‘rinishida ketma-ket chiqadi.'
    },
    {
      no: 5,
      icon: '✅',
      title: 'Mavzular ochiq',
      text: 'Hozircha keyingi mavzular ham ochiq. Foizlar faqat o‘zlashtirishni ko‘rsatish uchun saqlanadi.'
    },
    {
      no: 6,
      icon: '🏆',
      title: 'Yakuniy test va sertifikat',
      text: 'Darajadagi barcha mavzular tugagach yakuniy test ochiladi. 90%+ natija olsangiz sertifikat beriladi va uni PDF qilib yuklab olishingiz mumkin.'
    }
  ];

  const rules = [
    'Nuqta qo‘yish yoki qo‘ymaslik yozma mashqda xato hisoblanmaydi.',
    'Man/Men, San/Sen va o‘zbekcha apostrof farqlari bir xil qabul qilinadi.',
    'Qisqartmalar ham hisobga olinadi: I’m = I am, she’s = she is, aren’t = are not.',
    'Faqat bitta so‘z yozish yetarli emas — to‘liq gap yozing, tizim ma’no va grammatikani tekshiradi.',
    'Statistika bo‘limida eng sust mavzular tepada chiqadi, avval shularni qayta ishlang.'
  ];

  return (
    <section className="remindersPanel">
      <div className="reminderHeroCard">
        <div>
          <span className="eyebrow">Foydalanish tartibi</span>
          <h2>Saytdan qanday foydalaniladi?</h2>
          <p>Bu bo‘limda platformada dars o‘qish, mashq bajarish, keyingi mavzuni ochish va sertifikat olish tartibi ko‘rsatilgan.</p>
        </div>
        <div className="reminderProgressMini">
          <TopicProgressRing value={overallPercent} />
          <b>{completedCount}/{totalTopics}</b>
          <small>mavzu 90%+</small>
        </div>
      </div>

      <div className="usageStepList">
        {guideSteps.map(step => (
          <article className="usageStepCard" key={step.no}>
            <div className="usageStepNumber">{step.no}</div>
            <div className="usageStepIcon">{step.icon}</div>
            <div>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </div>
          </article>
        ))}
      </div>

      <div className="reminderGrid">
        <div className="reminderInfoCard">
          <div className="sectionHead reminderCardHead">
            <div>
              <h2>Muhim qoidalar</h2>
              <p>Mashq bajarishda quyidagi qoidalarga amal qiling.</p>
            </div>
            <span>📌</span>
          </div>
          <div className="reminderRuleList">
            {rules.map((rule, index) => (
              <div className="reminderRule" key={rule}>
                <b>{index + 1}</b>
                <span>{rule}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="reminderInfoCard focusTopicsCard">
          <div className="sectionHead reminderCardHead">
            <div>
              <h2>Qayta o‘qish kerak</h2>
              <p>90% dan past mavzular birinchi ko‘rsatiladi.</p>
            </div>
            <span>🔥</span>
          </div>
          {weakTopics.length ? (
            <div className="reminderWeakList">
              {weakTopics.map(topic => (
                <button type="button" className="reminderWeakRow" key={topic.id} onClick={() => onOpenTopic(topic)}>
                  <div>
                    <b>{topic.topicNo}. {topic.title}</b>
                    <small>Urinishlar: {topic.attempts || 0} marta</small>
                  </div>
                  <strong>{clampPercent(topic.bestScore)}%</strong>
                </button>
              ))}
            </div>
          ) : (
            <div className="reminderSuccessBox">
              <b>Zo‘r natija!</b>
              <span>Hozircha 90% dan past ochiq mavzu yo‘q.</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}


function StudentPlaceholderPanel({ title, text, icon }) {
  return (
    <section className="statsPanel">
      <div className="statsHeroCard placeholderPanel">
        <div className="placeholderIcon">{icon}</div>
        <div>
          <h2>{title}</h2>
          <p>{text}</p>
        </div>
      </div>
    </section>
  );
}


const STUDENT_NOT_READY_LEVELS = ['Intermediate'];
const STUDENT_NOT_READY_MESSAGE = 'Bu daraja hali tayyor emas. Bu daraja ustida ishlanmoqda. Iltimos administratorga murojaat qiling.';
function normalizeLevelName(value, availableLevels = ['Beginner', 'Elementary', 'Pre-Intermediate', 'Intermediate']) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, '');
  return availableLevels.find(level => level.toLowerCase().replace(/\s+/g, '') === compact) || '';
}
function hasOpenedLevel(accessMap = {}, unlockedLevels = [], lv, availableLevels) {
  if (lv === 'Beginner') return true;
  if (accessMap?.[lv] === true) return true;
  const normalized = unlockedLevels.map(item => normalizeLevelName(item, availableLevels)).filter(Boolean);
  return normalized.includes(lv);
}


function AdminLevelConfirmModal({ level, onConfirm, onCancel }) {
  if (!level) return null;
  return (
    <div className="adminLevelConfirmOverlay" role="dialog" aria-modal="true">
      <div className="adminLevelConfirmCard">
        <div className="adminLevelConfirmIcon">✅</div>
        <h2>{level} bo‘limiga o‘tmoqchimisiz?</h2>
        <p>Bu bo‘lim admin tomonidan sizga ochib berilgan. “Ha” bossangiz, ruxsat testisiz mavzularga o‘tasiz.</p>
        <div className="adminLevelConfirmActions">
          <button type="button" className="secondaryBtn" onClick={onCancel}>Yo‘q</button>
          <button type="button" className="primaryBtn" onClick={onConfirm}>Ha, o‘tish</button>
        </div>
      </div>
    </div>
  );
}

function StudentPanel({ user, onLogout }) {
  const [content, setContent] = useState(null);
  const [progress, setProgress] = useState(null);
  const [subject, setSubject] = useState('english');
  const [level, setLevel] = useState('Beginner');
  const [topics, setTopics] = useState([]);
  const [finalUnlocked, setFinalUnlocked] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [gate, setGate] = useState(null);
  const [finalTest, setFinalTest] = useState(null);
  const [finalResult, setFinalResult] = useState(null);
  const [activeTab, setActiveTab] = useState('lessons');
  const [pendingAdminLevel, setPendingAdminLevel] = useState(null);
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' ? window.innerWidth <= 768 : false);

  async function loadBase() {
    const c = await api('/api/content');
    const p = await api('/api/progress');
    setContent(c);
    setProgress(p);
    const firstSubject = c.subjects[0]?.id || 'english';
    setSubject(prev => c.subjects.some(s => s.id === prev) ? prev : firstSubject);
    return { c, p, firstSubject };
  }
  async function loadTopics(selectedSubject = subject, selectedLevel = level) {
    const data = await api(`/api/topics/${selectedSubject}/${selectedLevel}`);
    setTopics(data.topics);
    setFinalUnlocked(data.finalUnlocked);
  }
  useEffect(() => { loadBase().then(({ firstSubject }) => loadTopics(firstSubject, 'Beginner')).catch(err => alert(err.message)); }, []);
  useEffect(() => { if (content && progress) loadTopics(subject, level).catch(() => {}); }, [subject, level]);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  async function selectLevel(lv) {
    setSelectedTopic(null);
    setGate(null);
    setFinalTest(null);
    setFinalResult(null);

    // Admin qo'lda ochgan daraja bosilganda avval tasdiqlash modali chiqadi.
    // Ha bosilgandan keyin ruxsat testisiz mavzularga o'tadi.
    let latestProgress = progress;
    try {
      latestProgress = await api('/api/progress');
      setProgress(latestProgress);
    } catch (err) {
      latestProgress = progress;
    }

    const subjectAccess = latestProgress?.access?.[subject] || {};
    const unlockedFromUser = Array.isArray(user?.unlockedLevels) ? user.unlockedLevels : [];
    const availableLevels = content?.levels || ['Beginner', 'Elementary', 'Pre-Intermediate', 'Intermediate'];
    const adminOpenedLevel = hasOpenedLevel(subjectAccess, unlockedFromUser, lv, availableLevels);

    if (adminOpenedLevel) {
      setPendingAdminLevel(lv);
      return;
    }

    // Faqat admin ochmagan va hali tayyor qilinmagan darajalar bloklanadi.
    if (STUDENT_NOT_READY_LEVELS.includes(lv)) {
      alert(STUDENT_NOT_READY_MESSAGE);
      return;
    }

    // Admin ochmagan darajada odatiy kirish testi ishlaydi.
    const test = await api(`/api/gate-test/${subject}/${lv}`);

    // Backend ham “alreadyUnlocked” qaytarsa, modal ko'rsatmaymiz.
    if (test?.alreadyUnlocked) {
      setLevel(lv);
      setGate(null);
      setActiveTab('lessons');
      await loadBase();
      await loadTopics(subject, lv);
      return;
    }

    setLevel(lv);
    setGate(test);
  }
  async function submitGate(answers) {
    const result = await api(`/api/gate-test/${subject}/${level}`, { method: 'POST', body: JSON.stringify({ answers }) });
    await loadBase();
    await loadTopics(subject, level);
    return result;
  }
  async function submitTopicPractice(topic, payload) {
    const result = await api(`/api/topic-practice/${topic.language}/${topic.level}/${topic.topicNo}`, { method: 'POST', body: JSON.stringify(payload) });
    await loadBase();
    await loadTopics(topic.language, topic.level);
    return result;
  }
  function handleSpeakingSaved(topic, topicSpeaking, globalSpeaking) {
    setProgress(prev => prev ? { ...prev, speakingSummary: globalSpeaking || prev.speakingSummary } : prev);
    setSelectedTopic(prev => prev && prev.id === topic.id ? {
      ...prev,
      speakingScore: topicSpeaking?.score || topicSpeaking?.percent || 0,
      speakingBestScore: topicSpeaking?.bestScore || topicSpeaking?.score || 0,
      speakingCheckedWords: topicSpeaking?.checkedWords || 0,
      speakingPassedWords: topicSpeaking?.passedWords || 0,
      speakingTotalWords: topicSpeaking?.totalWords || 30,
      speakingAttempts: topicSpeaking?.attempts || 0
    } : prev);
  }
  async function goNextTopic(topic) {
    const data = await api(`/api/topics/${topic.language}/${topic.level}`);
    setTopics(data.topics);
    setFinalUnlocked(data.finalUnlocked);
    const nextTopic = data.topics.find(t => t.topicNo === topic.topicNo + 1 && t.unlocked);
    if (nextTopic) {
      setSelectedTopic(nextTopic);
    } else {
      setSelectedTopic(null);
      setActiveTab('lessons');
    }
  }
  async function openFinal() {
    try {
      setFinalTest(await api(`/api/final-test/${subject}/${level}`));
      setFinalResult(null);
    } catch (err) {
      alert(err.message);
    }
  }
  async function submitFinal(answers) {
    const result = await api(`/api/final-test/${subject}/${level}`, { method: 'POST', body: JSON.stringify({ answers }) });
    setFinalResult(result);
    await loadBase();
    return result;
  }

  async function confirmAdminLevel() {
    const lv = pendingAdminLevel;
    if (!lv) return;
    setPendingAdminLevel(null);
    setSelectedTopic(null);
    setGate(null);
    setFinalTest(null);
    setFinalResult(null);
    setLevel(lv);
    setActiveTab('lessons');
    await loadTopics(subject, lv);
  }

  function cancelAdminLevel() {
    setPendingAdminLevel(null);
  }

  const selectedSubjectTitle = useMemo(() => content?.subjects?.find(s => s.id === subject)?.title || '', [content, subject]);
  const completedCount = topics.filter(t => t.bestScore >= TOPIC_PASS_SCORE).length;
  const totalTopics = topics.length || 15;
  const overallPercent = Math.round((completedCount / totalTopics) * 100);
  const currentTopic = topics.find(t => t.unlocked && t.bestScore < TOPIC_PASS_SCORE) || topics.find(t => t.unlocked);
  const activeTopics = topics.filter(t => t.unlocked && (t.bestScore > 0 || t.id === currentTopic?.id));
  const nextTopics = topics.filter(t => !activeTopics.some(active => active.id === t.id));

  if (!content || !progress) return <main className="page"><div className="card">Yuklanmoqda...</div></main>;
  if (selectedTopic) return <main className="page"><TopicView topic={selectedTopic} onPracticeSubmit={submitTopicPractice} onGoNext={goNextTopic} onSpeakingSaved={handleSpeakingSaved} onBack={() => { setSelectedTopic(null); loadTopics(); loadBase(); }} /></main>;
  if (gate) return <main className="page"><section className="hero"><span className="eyebrow">Ruxsat testi</span><h1>{level} darajasi uchun test</h1><p>Daraja testi oldingi daraja yakuniy testi 90%+ bo‘lganda ochiladi.</p></section><TestView test={gate} onSubmit={submitGate} onCancel={() => setGate(null)} submitText="Ruxsat testini tekshirish" /></main>;
  if (finalTest) return <main className="page"><TestView test={finalTest} onSubmit={submitFinal} onCancel={() => setFinalTest(null)} submitText="Daraja testini yakunlash" />{finalResult?.certificate && <div className="card finalCertificateCard"><h2>Sertifikat tayyorlandi</h2><p className="muted">Daraja testi natijangiz sertifikatga yozildi. Sertifikatni ko‘rish yoki rasm qilib yuklab olish mumkin.</p><CertificatePreview certificate={finalResult.certificate} /></div>}</main>;

  if (isMobile) return (
    <>
      <MobileStudentDashboard
        user={user}
        onLogout={onLogout}
        content={content}
        progress={progress}
        subject={subject}
        setSubject={setSubject}
        level={level}
        selectLevel={selectLevel}
        topics={topics}
        currentTopic={currentTopic}
        overallPercent={overallPercent}
        completedCount={completedCount}
        totalTopics={totalTopics}
        openTopic={setSelectedTopic}
        openFinal={openFinal}
        finalUnlocked={finalUnlocked}
      />
      <AdminLevelConfirmModal level={pendingAdminLevel} onConfirm={confirmAdminLevel} onCancel={cancelAdminLevel} />
    </>
  );

  return (
    <>
      <DesktopStudentDashboard
        user={user}
        onLogout={onLogout}
        content={content}
        progress={progress}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        subject={subject}
        level={level}
        selectLevel={selectLevel}
        topics={topics}
        currentTopic={currentTopic}
        completedCount={completedCount}
        totalTopics={totalTopics}
        overallPercent={overallPercent}
        openTopic={setSelectedTopic}
        openFinal={openFinal}
        finalUnlocked={finalUnlocked}
      />
      <AdminLevelConfirmModal level={pendingAdminLevel} onConfirm={confirmAdminLevel} onCancel={cancelAdminLevel} />
    </>
  );

  /* legacy desktop layout
  return (
    <main className="studentDashboardPage">
      <aside className="studentSidebar">
        <div className="sideCourseLabel">KURS</div>
        <div className="sideCourseTop">
          <div className="sideCourseIcon">📘</div>
          <div>
            <b>{selectedSubjectTitle || 'ENGLISH Mock Course'}</b>
            <span>{level} daraja</span>
          </div>
        </div>

        <div className="sideProgressCard">
          <span>Umumiy o‘zlashtirish</span>
          <strong>{overallPercent}%</strong>
          <p>{totalTopics} darsdan {completedCount} tasi 90%+ bilan yakunlangan</p>
          <div className="sideProgressTrack"><i style={{ width: `${overallPercent}%` }} /></div>
        </div>

        <div className="studentSideMenu">
          <button type="button" className={activeTab === 'lessons' ? 'active' : ''} onClick={() => setActiveTab('lessons')}><span>📚</span> Darslar</button>
          <button type="button" className={activeTab === 'stats' ? 'active' : ''} onClick={() => setActiveTab('stats')}><span>📊</span> Statistika</button>
          <button type="button" className={activeTab === 'achievements' ? 'active' : ''} onClick={() => setActiveTab('achievements')}><span>🏆</span> Yutuqlar</button>
          <button type="button" className={activeTab === 'reminders' ? 'active' : ''} onClick={() => setActiveTab('reminders')}><span>🔔</span> Eslatmalar</button>
        </div>

        <div className="sideHelpCard">
          <b>Yordam kerakmi?</b>
          <p>Savollaringiz bo‘lsa, admin bilan bog‘laning.</p>
          <button type="button" className="ghost">🎧 Bog‘lanish</button>
        </div>
      </aside>

      <section className="studentCourseMain">
        <div className="courseMainHeader">
          <div>
            <span className="eyebrow">O‘quvchi panel</span>
            <h1>{activeTab === 'stats' ? 'Statistika' : activeTab === 'achievements' ? 'Yutuqlar' : activeTab === 'reminders' ? 'Eslatmalar' : 'Darslar'}</h1>
            <p>{activeTab === 'stats'
              ? 'Mavzular foiz bo‘yicha tartiblanadi: yaxshi o‘zlashtirilmagan mavzular birinchi ko‘rinadi.'
              : activeTab === 'achievements'
                ? 'Sertifikatlar va 90%+ natijalar shu yerda jamlanadi.'
                : activeTab === 'reminders'
                  ? 'Platformadan foydalanish tartibi, muhim qoidalar va qayta o‘qish kerak bo‘lgan mavzular.'
                  : 'Darslarni ketma-ket o‘zlashtirib boring. Har bir mavzuda olingan foiz yonida yashil aylana bilan ko‘rinadi.'}</p>
          </div>
          <div className="courseHeaderRight">
            <div className="courseGoalCard">
              <span>🎯</span>
              <div>
                <b>Maqsad: 90% va undan yuqori</b>
                <small>Hozirgi o‘zlashtirish: {overallPercent}%</small>
              </div>
            </div>
            <div className="levelPills headerLevelPills">
              {content.levels.map((lv, index) => (
                <button
                  key={lv}
                  type="button"
                  className={`levelPill ${level === lv ? 'active' : ''} ${progress.access[subject]?.[lv] ? 'open' : 'locked'}`}
                  onClick={() => selectLevel(lv)}
                >
                  <span>{progress.access[subject]?.[lv] ? '✓' : '🔒'}</span>
                  <b>{lv}</b>
                  <small>{progress.access[subject]?.[lv] ? 'Ochiq' : (STUDENT_NOT_READY_LEVELS.includes(lv) ? 'Ishlanmoqda' : (index === 0 ? 'Ochiq' : 'Test kerak'))}</small>
                </button>
              ))}
            </div>
          </div>
        </div>

        {activeTab === 'lessons' && <>
        <section className="lessonListPanel">
          <div className="sectionHead lessonListHead">
            <div>
              <h2>Mavzular yo‘li</h2>
              <p>Hozircha barcha mavzular va testlar ochiq.</p>
            </div>
            <b className="countBadge">{completedCount}/{totalTopics}</b>
          </div>

          <div className="lessonGroup">
            <h3>O‘zlashtirilgan darslar</h3>
            <div className="lessonRows">
              {activeTopics.length ? activeTopics.map(t => (
                <TopicLessonRow key={t.id} topic={t} isCurrent={currentTopic?.id === t.id} onClick={() => setSelectedTopic(t)} />
              )) : <div className="emptyLessonRow">Hali o‘zlashtirilgan dars yo‘q</div>}
            </div>
          </div>

          <div className="lessonGroup nextLessonsGroup">
            <h3>Keyingi darslar</h3>
            <NextLessonsSwiper topics={nextTopics} currentTopic={currentTopic} onOpenTopic={setSelectedTopic} />
          </div>
        </section>

        <section className="courseBottomGrid">
          <div className="finalCard courseMiniPanel">
            <h2>Daraja yakuniy testi</h2>
            <p>{totalTopics} ta mavzuni 90%+ bilan tugatsangiz ochiladi. 90%+ olsangiz ENGLISH Mock sertifikati beriladi.</p>
            <button className="primary" disabled={!finalUnlocked} onClick={openFinal}>{finalUnlocked ? 'Yakuniy testni ochish' : `Yakuniy testni ochish`}</button>
          </div>

          <div className="courseMiniPanel">
            <h2>Sertifikatlar</h2>
            <div className="certGrid compactCerts">
              {progress.certificates.length ? progress.certificates.map(c => <CertificateTile key={c.id} certificate={c} />) : <p className="empty">Hali sertifikat yo‘q</p>}
            </div>
            {progress.certificates.length > 0 && <CertificatePreview certificate={progress.certificates[progress.certificates.length - 1]} compact />}
          </div>
        </section>
        </>}

        {activeTab === 'stats' && (
          <StudentStatsPanel
            topics={topics}
            completedCount={completedCount}
            totalTopics={totalTopics}
            overallPercent={overallPercent}
            speakingSummary={progress.speakingSummary}
            onOpenTopic={setSelectedTopic}
            content={content}
            progress={progress}
            subject={subject}
            level={level}
            selectLevel={selectLevel}
          />
        )}

        {activeTab === 'achievements' && (
          <section className="lessonListPanel achievementsPanel">
            <div className="sectionHead lessonListHead">
              <div>
                <h2>Sertifikatlar</h2>
                <p>Berilgan sertifikatlar rasmi shu yerda doim ko‘rinib turadi.</p>
              </div>
              <b className="countBadge">{progress.certificates.length} ta</b>
            </div>
            {progress.certificates.length ? progress.certificates.map(c => <CertificatePreview key={c.id} certificate={c} />) : <p className="empty">Hali sertifikat yo‘q</p>}
          </section>
        )}

        {activeTab === 'reminders' && (
          <StudentRemindersPanel
            topics={topics}
            completedCount={completedCount}
            totalTopics={totalTopics}
            overallPercent={overallPercent}
            speakingSummary={progress.speakingSummary}
            onOpenTopic={setSelectedTopic}
          />
        )}
      </section>
    </main>
  );
  */
}

function App() {
  const [user, setUser] = useState(null);
  const [authMessage, setAuthMessage] = useState('');

  useEffect(() => {
    const onExpired = (event) => {
      setUser(null);
      setAuthMessage(event.detail || 'Sessiya tugagan. Qayta login qiling.');
    };
    window.addEventListener('auth-expired', onExpired);
    api('/api/me').then(d => setUser(d.user)).catch(() => {});
    return () => window.removeEventListener('auth-expired', onExpired);
  }, []);

  function handleLogin(nextUser) {
    setAuthMessage('');
    setUser(nextUser);
  }

  function logout() {
    setAuthMessage('Tizimdan chiqdingiz. Qayta login qiling.');
    setUser(null);
    logoutToLogin();
  }

  if (!user) return <Landing onLogin={handleLogin} authMessage={authMessage} />;
  if (user.role === 'admin') return <AdminPanel onLogout={logout} />;
  if (user.role === 'teacher') return <TeacherPanel user={user} onLogout={logout} />;
  return <StudentPanel user={user} onLogout={logout} />;
}

createRoot(document.getElementById('root')).render(<App />);
