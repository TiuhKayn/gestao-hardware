import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, updateDoc, onSnapshot, query, where, writeBatch } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyDeM2rW7GktcduSzCQ8v3Xp2epnwB4UJEc",
    authDomain: "gestao-hardware.firebaseapp.com",
    projectId: "gestao-hardware",
    storageBucket: "gestao-hardware.firebasestorage.app",
    messagingSenderId: "845594249944",
    appId: "1:845594249944:web:c2400da10533827d6625ad"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

/* =====================================================================
   Organizador de recebíveis (vendas parceladas)

   Uma venda tem: valor total, entrada (já recebida na hora) e uma lista de
   parcelas. Cada parcela vence numa DATA CERTA ou "a combinar no mês"
   (semData + mes). Parcela paga guarda a data real do recebimento.
   Regra de ouro: entrada + soma das parcelas = valor total.
   ===================================================================== */

/* ---------- utilidades ---------- */
const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/* ---------- datas (sempre no fuso local; toISOString() é UTC e vira o dia à noite em Manaus) ---------- */
function hojeLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const mesDe = (iso) => String(iso || '').slice(0, 7);
const ehMesISO = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '');

function ehDataISO(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function normalizarDataQualquer(s) {
    if (!s) return null;
    const t = String(s).trim();
    if (ehDataISO(t)) return t;
    const m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // dados antigos digitados à mão (dd/mm/aaaa)
    if (m) {
        const iso = `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
        return ehDataISO(iso) ? iso : null;
    }
    return null;
}

function formatDateBR(iso) {
    if (!ehDataISO(iso)) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}

function nomeMes(ym, comAno = false) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', comAno ? { month: 'long', year: 'numeric' } : { month: 'long' });
}
function nomeMesRelativo(ym) {
    const anoAtual = Number(hojeLocal().slice(0, 4));
    return nomeMes(ym, Number(ym.slice(0, 4)) !== anoAtual);
}

function addMesesYM(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const t = y * 12 + (m - 1) + n;
    return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`;
}
function dataNoMes(ym, dia) {
    const [y, m] = ym.split('-').map(Number);
    const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${ym}-${pad2(Math.min(dia, ultimo))}`;
}
function addMesesPreservandoDia(iso, n) {
    const dia = Number(iso.slice(8, 10));
    return dataNoMes(addMesesYM(mesDe(iso), n), dia);
}
function addDias(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function diasEntre(deIso, ateIso) {
    const f = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((f(ateIso) - f(deIso)) / 86400000);
}
function diaSemanaCurto(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
}

/* ---------- dinheiro (em centavos pra somar sem erro de ponto flutuante) ---------- */
const centavos = (v) => Math.round((Number(v) || 0) * 100);
const fmtBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dinheiro = (v) => fmtBRL.format(Number(v) || 0).replace(/ /g, ' ');

function dividirCentavos(total, n) {
    const base = Math.floor(total / n);
    const lista = Array(n).fill(base);
    lista[n - 1] = total - base * (n - 1);
    return lista;
}

/* ---------- estado ---------- */
let vendas = [];
let carregado = false;
let mes = hojeLocal().slice(0, 7);
let filtro = 'abertas';
let busca = '';
let mostrarRecebidas = false;
const expandidas = new Set();
let unsubscribe = null;
let salvando = false;

/* ---------- normalização (aceita documentos antigos) ---------- */
function normalizarParcela(p, mesDaVenda) {
    const pago = !!p.pago;
    let vencimento = normalizarDataQualquer(p.vencimento);
    const semData = !!p.semData || !vencimento;
    let m = ehMesISO(p.mes) ? p.mes : null;
    if (semData) {
        vencimento = null;
        m = m || mesDaVenda;
    } else {
        m = mesDe(vencimento);
    }
    return {
        valor: Math.round((Number(p.valor) || 0) * 100) / 100,
        semData,
        vencimento,
        mes: m,
        pago,
        dataPagamento: pago ? normalizarDataQualquer(p.dataPagamento) : null
    };
}

function normalizarVenda(id, d) {
    const dataVenda = normalizarDataQualquer(d.dataVenda) || normalizarDataQualquer(d.data) || hojeLocal();
    const valorTotal = Math.round((Number(d.valorTotal ?? d.valor) || 0) * 100) / 100;
    const parcelas = Array.isArray(d.parcelas) ? d.parcelas.map((p) => normalizarParcela(p, mesDe(dataVenda))) : [];
    const entrada = d.entrada != null ? Number(d.entrada) || 0 : (parcelas.length ? 0 : valorTotal);
    return {
        id,
        cliente: String(d.cliente ?? '').trim() || 'Sem nome',
        produto: String(d.produto ?? d.desc ?? '').trim(),
        obs: String(d.obs ?? ''),
        dataVenda,
        valorTotal,
        entrada,
        parcelas
    };
}

/* ---------- regras de negócio ---------- */
const dataRecebimento = (p) => p.dataPagamento || p.vencimento || (p.mes ? `${p.mes}-01` : null);
const ordemParcela = (p) => (p.semData ? `${p.mes}-99` : p.vencimento) || '';

function atrasada(p, hoje) {
    if (p.pago) return false;
    return p.semData ? p.mes < mesDe(hoje) : p.vencimento < hoje;
}

function rotuloQuando(p, hoje) {
    if (p.pago) return { estado: 'paga', texto: `Recebida em ${formatDateBR(dataRecebimento(p)) || '—'}` };
    if (p.semData) {
        if (p.mes < mesDe(hoje)) return { estado: 'atrasada', texto: `Atrasada — era pra ${nomeMesRelativo(p.mes)}` };
        return { estado: 'combinar', texto: `A combinar em ${nomeMesRelativo(p.mes)}` };
    }
    const d = diasEntre(hoje, p.vencimento);
    const dm = formatDateBR(p.vencimento).slice(0, 5);
    const dia = diaSemanaCurto(p.vencimento);
    if (d < 0) return { estado: 'atrasada', texto: d === -1 ? `Venceu ontem (${dm})` : `Venceu há ${-d} dias (${dm})` };
    if (d === 0) return { estado: 'hoje', texto: 'Vence hoje' };
    if (d === 1) return { estado: 'futura', texto: `Vence amanhã (${dia}, ${dm})` };
    if (d <= 7) return { estado: 'futura', texto: `Vence ${dia}, ${dm} (em ${d} dias)` };
    return { estado: 'futura', texto: `Vence ${dia}, ${formatDateBR(p.vencimento)}` };
}

function todasParcelas() {
    const out = [];
    vendas.forEach((v) => v.parcelas.forEach((p, idx) => out.push({ v, p, idx })));
    return out;
}

function resumoVenda(v, hoje) {
    let aberto = 0, recebidoParcelas = 0, atrasadas = 0, proximo = null;
    v.parcelas.forEach((p) => {
        const c = centavos(p.valor);
        if (p.pago) { recebidoParcelas += c; return; }
        aberto += c;
        if (atrasada(p, hoje)) atrasadas++;
        const o = ordemParcela(p);
        if (!proximo || o < proximo) proximo = o;
    });
    return { aberto, recebido: centavos(v.entrada) + recebidoParcelas, total: centavos(v.valorTotal), atrasadas, proximo, quitada: aberto === 0 };
}

function calcularResumo(hoje) {
    const r = { totalAberto: 0, nAbertas: 0, vendasAbertas: new Set(), atrasado: 0, nAtrasadas: 0, mesAberto: 0, nMes: 0, nMesSemData: 0, recebidoMes: 0, nRecebidosMes: 0 };
    for (const v of vendas) {
        const ent = centavos(v.entrada);
        if (ent > 0 && mesDe(v.dataVenda) === mes) { r.recebidoMes += ent; r.nRecebidosMes++; }
        for (const p of v.parcelas) {
            const c = centavos(p.valor);
            if (p.pago) {
                if (mesDe(dataRecebimento(p)) === mes) { r.recebidoMes += c; r.nRecebidosMes++; }
                continue;
            }
            r.totalAberto += c; r.nAbertas++; r.vendasAbertas.add(v.id);
            if (atrasada(p, hoje)) { r.atrasado += c; r.nAtrasadas++; }
            if (p.mes === mes) { r.mesAberto += c; r.nMes++; if (p.semData) r.nMesSemData++; }
        }
    }
    return r;
}

function recebimentosDoMes() {
    const itens = [];
    for (const v of vendas) {
        if (centavos(v.entrada) > 0 && mesDe(v.dataVenda) === mes) itens.push({ tipo: 'entrada', v, data: v.dataVenda, valor: v.entrada });
        v.parcelas.forEach((p, idx) => {
            if (p.pago && mesDe(dataRecebimento(p)) === mes) itens.push({ tipo: 'parcela', v, idx, data: dataRecebimento(p), valor: p.valor });
        });
    }
    return itens.sort((a, b) => b.data.localeCompare(a.data));
}

function serializarParcelas(parcelas, ordenar = true) {
    const lista = ordenar ? [...parcelas].sort((a, b) => ordemParcela(a).localeCompare(ordemParcela(b))) : parcelas;
    return lista.map((p, i) => ({
        numero: i + 1,
        valor: Math.round((Number(p.valor) || 0) * 100) / 100,
        vencimento: p.semData ? null : p.vencimento,
        semData: !!p.semData,
        mes: p.semData ? p.mes : mesDe(p.vencimento),
        pago: !!p.pago,
        dataPagamento: p.pago ? (p.dataPagamento || null) : null
    }));
}

/* ---------- renderização ---------- */
function htmlLinhaParcela(v, idx, { mostrarCliente = true } = {}) {
    const p = v.parcelas[idx];
    const q = rotuloQuando(p, hojeLocal());
    const info = `Parcela ${idx + 1}/${v.parcelas.length}`;
    const ids = `data-venda="${esc(v.id)}" data-idx="${idx}"`;
    const acoes = p.pago
        ? `<button type="button" class="vp-btn vp-btn-sm" data-acao="desfazer" ${ids}>Desfazer</button>`
        : `<button type="button" class="vp-btn vp-btn-sm vp-btn-ok" data-acao="receber" ${ids}>Recebi</button>
           <button type="button" class="vp-btn vp-btn-sm" data-acao="remarcar" ${ids}>Remarcar</button>`;
    const principal = mostrarCliente
        ? `<div class="vp-row-cliente">${esc(v.cliente)}</div><div class="vp-row-sub">${esc(v.produto)} · ${info}</div>`
        : `<div class="vp-row-cliente">${info}</div>`;
    return `<div class="vp-row st-${q.estado}">
        <div class="vp-row-main">${principal}<div class="vp-row-quando">${esc(q.texto)}</div></div>
        <div class="vp-row-valor">${dinheiro(p.valor)}</div>
        <div class="vp-row-acoes">${acoes}</div>
    </div>`;
}

function htmlLinhaEntrada(v, { mostrarCliente = true } = {}) {
    const rotulo = v.parcelas.length === 0 ? 'À vista' : 'Entrada';
    const principal = mostrarCliente
        ? `<div class="vp-row-cliente">${esc(v.cliente)}</div><div class="vp-row-sub">${esc(v.produto)} · ${rotulo}</div>`
        : `<div class="vp-row-cliente">${rotulo}</div>`;
    return `<div class="vp-row st-paga">
        <div class="vp-row-main">${principal}<div class="vp-row-quando">Recebida em ${formatDateBR(v.dataVenda)}</div></div>
        <div class="vp-row-valor">${dinheiro(v.entrada)}</div>
    </div>`;
}

function grupoHtml({ titulo, cor, qtd, totalC, corpo, vazio, botao = '', recolhido = false }) {
    const conteudo = qtd ? (recolhido ? '' : corpo) : `<div class="vp-vazio">${vazio}</div>`;
    return `<div class="vp-group" style="--vp-cor:${cor}">
        <div class="vp-group-head">
            <div class="vp-group-title">${titulo} <span style="opacity:.7">· ${qtd}</span></div>
            <div style="display:flex; align-items:center; gap:10px;">${totalC ? `<div class="vp-group-total">${dinheiro(totalC / 100)}</div>` : ''}${botao}</div>
        </div>
        ${conteudo}
    </div>`;
}

const somaC = (lista) => lista.reduce((s, x) => s + centavos(x.p ? x.p.valor : x.valor), 0);

function renderMesLabel() {
    $('mes-label').textContent = cap(nomeMes(mes, true));
}

function renderResumo() {
    const hoje = hojeLocal();
    const r = calcularResumo(hoje);
    const nomeM = nomeMes(mes);
    $('res-total').textContent = dinheiro(r.totalAberto / 100);
    $('res-total-sub').textContent = r.nAbertas ? `${plural(r.nAbertas, 'parcela', 'parcelas')} em ${plural(r.vendasAbertas.size, 'venda', 'vendas')}` : 'Nada em aberto';
    $('res-atrasado').textContent = dinheiro(r.atrasado / 100);
    $('res-atrasado-sub').textContent = r.nAtrasadas ? plural(r.nAtrasadas, 'parcela atrasada', 'parcelas atrasadas') : 'Nenhuma atrasada';
    $('res-mes-titulo').textContent = `A receber em ${nomeM}`;
    $('res-mes').textContent = dinheiro(r.mesAberto / 100);
    $('res-mes-sub').textContent = r.nMes ? `${plural(r.nMes, 'parcela', 'parcelas')}${r.nMesSemData ? ` (${r.nMesSemData} sem data)` : ''}` : 'Nada pendente no mês';
    $('res-recebido-titulo').textContent = `Recebido em ${nomeM}`;
    $('res-recebido').textContent = dinheiro(r.recebidoMes / 100);
    $('res-recebido-sub').textContent = r.nRecebidosMes ? plural(r.nRecebidosMes, 'recebimento', 'recebimentos') : 'Nenhum recebimento';
}

function renderQuadro() {
    $('quadro-mes').textContent = nomeMes(mes, true);
    const cont = $('quadro');
    if (!carregado) { cont.innerHTML = '<div class="vp-vazio">Carregando...</div>'; return; }

    const hoje = hojeLocal();
    const flat = todasParcelas();
    const porCliente = (a, b) => a.v.cliente.localeCompare(b.v.cliente, 'pt-BR');
    const porOrdem = (a, b) => ordemParcela(a.p).localeCompare(ordemParcela(b.p)) || porCliente(a, b);

    const anteriores = flat.filter((x) => !x.p.pago && atrasada(x.p, hoje) && x.p.mes < mes).sort(porOrdem);
    const comData = flat.filter((x) => !x.p.pago && !x.p.semData && x.p.mes === mes).sort(porOrdem);
    const semData = flat.filter((x) => !x.p.pago && x.p.semData && x.p.mes === mes).sort(porCliente);
    const recebidos = recebimentosDoMes();
    const linhas = (lista) => lista.map((x) => htmlLinhaParcela(x.v, x.idx)).join('');

    let html = '';
    if (anteriores.length) {
        html += grupoHtml({ titulo: `🚨 Atrasadas de antes de ${nomeMes(mes)}`, cor: 'var(--danger)', qtd: anteriores.length, totalC: somaC(anteriores), corpo: linhas(anteriores) });
    }
    html += grupoHtml({
        titulo: `📅 Com data marcada em ${nomeMes(mes)}`, cor: 'var(--accent-primary)', qtd: comData.length, totalC: somaC(comData), corpo: linhas(comData),
        vazio: 'Nenhuma cobrança com data marcada neste mês.'
    });
    html += grupoHtml({
        titulo: `🤝 A combinar em ${nomeMes(mes)} (sem data certa)`, cor: '#38bdf8', qtd: semData.length, totalC: somaC(semData), corpo: linhas(semData),
        vazio: 'Nada a combinar neste mês.'
    });
    const corpoRecebidos = recebidos.map((x) => (x.tipo === 'entrada' ? htmlLinhaEntrada(x.v) : htmlLinhaParcela(x.v, x.idx))).join('');
    html += grupoHtml({
        titulo: `✅ Recebido em ${nomeMes(mes)}`, cor: 'var(--success)', qtd: recebidos.length, totalC: somaC(recebidos),
        corpo: corpoRecebidos, recolhido: !mostrarRecebidas, vazio: 'Nenhum recebimento neste mês.',
        botao: recebidos.length ? `<button type="button" class="vp-btn vp-btn-sm" data-acao="alternar-recebidas">${mostrarRecebidas ? 'Ocultar' : 'Mostrar'}</button>` : ''
    });
    cont.innerHTML = html;
}

function htmlVenda(v, r) {
    const aberta = expandidas.has(v.id);
    let badge;
    if (r.quitada) badge = `<span class="vp-badge ok">${v.parcelas.length ? 'Quitada' : 'À vista'}</span>`;
    else if (r.atrasadas) badge = `<span class="vp-badge atraso">${plural(r.atrasadas, 'parcela atrasada', 'parcelas atrasadas')}</span>`;
    else badge = '<span class="vp-badge aberto">Em aberto</span>';
    const pct = r.total > 0 ? Math.min(100, Math.round((r.recebido * 100) / r.total)) : 100;
    const corpo = [];
    if (centavos(v.entrada) > 0 && v.parcelas.length) corpo.push(htmlLinhaEntrada(v, { mostrarCliente: false }));
    v.parcelas.forEach((p, idx) => corpo.push(htmlLinhaParcela(v, idx, { mostrarCliente: false })));
    return `<div class="vp-venda${aberta ? ' aberta' : ''}">
        <div class="vp-venda-head" data-acao="alternar-venda" data-venda="${esc(v.id)}" role="button" tabindex="0" aria-expanded="${aberta}">
            <div class="vp-venda-info">
                <div class="vp-venda-cliente">${esc(v.cliente)}</div>
                <div class="vp-venda-sub">${esc(v.produto)} · venda de ${formatDateBR(v.dataVenda)}</div>
                ${badge}
            </div>
            <div class="vp-venda-valores">
                <div class="vp-venda-falta">${r.quitada ? dinheiro(r.total / 100) : `Falta ${dinheiro(r.aberto / 100)}`}</div>
                <div class="vp-venda-total">${r.quitada ? 'recebido por completo' : `de ${dinheiro(r.total / 100)} · ${pct}% recebido`}</div>
                <div class="vp-bar"><i style="width:${pct}%"></i></div>
            </div>
            <span class="vp-chevron" aria-hidden="true">▾</span>
        </div>
        <div class="vp-venda-body">
            ${v.obs ? `<div class="vp-venda-obs">📝 ${esc(v.obs)}</div>` : ''}
            ${corpo.length ? corpo.join('') : '<div class="vp-vazio">Venda sem parcelas.</div>'}
            <div class="vp-venda-acoes">
                <button type="button" class="vp-btn vp-btn-sm" data-acao="editar-venda" data-venda="${esc(v.id)}">Editar venda</button>
                <button type="button" class="vp-btn vp-btn-sm vp-btn-danger" data-acao="excluir-venda" data-venda="${esc(v.id)}">Excluir</button>
            </div>
        </div>
    </div>`;
}

function renderVendas() {
    const cont = $('lista-vendas');
    if (!carregado) { cont.innerHTML = '<div class="vp-vazio">Carregando...</div>'; return; }
    const hoje = hojeLocal();
    const termo = semAcento(busca.trim());
    let itens = vendas.map((v) => ({ v, r: resumoVenda(v, hoje) }));
    if (termo) itens = itens.filter(({ v }) => semAcento(`${v.cliente} ${v.produto} ${v.obs}`).includes(termo));

    const nAbertas = itens.filter((i) => !i.r.quitada).length;
    const nQuitadas = itens.length - nAbertas;
    $('vp-pills').innerHTML = [['abertas', `Em aberto (${nAbertas})`], ['quitadas', `Quitadas (${nQuitadas})`], ['todas', `Todas (${itens.length})`]]
        .map(([k, t]) => `<button type="button" class="vp-pill${filtro === k ? ' ativo' : ''}" data-acao="filtro" data-filtro="${k}">${t}</button>`).join('');

    if (filtro === 'abertas') itens = itens.filter((i) => !i.r.quitada);
    else if (filtro === 'quitadas') itens = itens.filter((i) => i.r.quitada);

    itens.sort((a, b) => {
        if (a.r.quitada !== b.r.quitada) return a.r.quitada ? 1 : -1;
        if (!a.r.quitada) return (a.r.proximo || '').localeCompare(b.r.proximo || '');
        return b.v.dataVenda.localeCompare(a.v.dataVenda);
    });

    if (!vendas.length) {
        cont.innerHTML = '<div class="vp-vazio">Nenhuma venda cadastrada ainda. Clique em “＋ Nova venda” pra começar, ou em “📥 Importar lista” pra colar uma anotação que você já tem.</div>';
    } else if (!itens.length) {
        cont.innerHTML = '<div class="vp-vazio">Nenhuma venda encontrada nesse filtro.</div>';
    } else {
        cont.innerHTML = itens.map(({ v, r }) => htmlVenda(v, r)).join('');
    }
}

function renderAll() {
    renderMesLabel();
    renderResumo();
    renderQuadro();
    renderVendas();
}

/* ---------- modais / avisos ---------- */
const MODAIS = ['modal-venda', 'modal-importar', 'modal-receber', 'modal-remarcar', 'modal-confirm'];
const MODAIS_LONGOS = ['modal-venda', 'modal-importar']; // têm o que digitar/colar: clicar fora não fecha
let ed = null;   // rascunho da venda aberta no editor
let imp = null;  // lista lida na importação aberta
let rec = null;  // parcela sendo recebida
let rem = null;  // parcela sendo remarcada
let confirmResolver = null;

function mostrarErro(id, msg) { const el = $(id); el.textContent = msg; el.classList.remove('vp-hidden'); }
function esconderErro(id) { $(id).classList.add('vp-hidden'); }

function abrirModal(id, focoId) {
    MODAIS.forEach((m) => $(m).classList.add('vp-hidden'));
    $('vp-overlay').classList.remove('vp-hidden');
    $(id).classList.remove('vp-hidden');
    // foco na hora (a janela já está visível): um setTimeout aqui podia roubar o foco de um campo que a pessoa já tinha clicado
    const el = focoId && $(focoId);
    if (el) el.focus();
}

function fecharModais() {
    MODAIS.forEach((m) => $(m).classList.add('vp-hidden'));
    $('vp-overlay').classList.add('vp-hidden');
    ed = null; imp = null; rec = null; rem = null;
    if (confirmResolver) { const r = confirmResolver; confirmResolver = null; r(false); }
}

function confirmar(msg, { titulo = 'Confirmar', botao = 'Confirmar', perigo = false } = {}) {
    return new Promise((resolve) => {
        confirmResolver = resolve;
        $('conf-titulo').textContent = titulo;
        $('conf-msg').textContent = msg;
        const b = $('btn-conf-sim');
        b.textContent = botao;
        b.className = perigo ? 'vp-btn vp-btn-danger' : 'vp-btn vp-btn-primary';
        abrirModal('modal-confirm', 'btn-conf-sim');
    });
}

function toast(msg, tipo = '') {
    const el = document.createElement('div');
    el.className = `vp-toast ${tipo}`;
    el.textContent = msg;
    $('vp-toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
}

async function gravar(fn, msgOk) {
    if (salvando) return false;
    salvando = true;
    try {
        await fn();
        fecharModais();
        if (msgOk) toast(msgOk, 'ok');
        return true;
    } catch (e) {
        console.error('Erro ao gravar:', e);
        toast('Não consegui salvar: ' + (e && e.message ? e.message : 'erro desconhecido'), 'erro');
        return false;
    } finally {
        salvando = false;
    }
}

// ordenar=false mantém a ordem atual (receber/desfazer não mudam datas; o "restante" de um
// recebimento parcial precisa ficar logo depois do pedaço pago).
function gravarParcelas(vendaId, parcelas, msgOk, ordenar = true) {
    return gravar(() => updateDoc(doc(db, 'vendas', vendaId), { parcelas: serializarParcelas(parcelas, ordenar), atualizadoEm: new Date().toISOString() }), msgOk);
}

/* ---------- editor de venda ---------- */
const rascunhoDe = (p) => ({ ...p, valor: p.pago ? p.valor : p.valor.toFixed(2) });

function abrirEditor(v) {
    const hoje = hojeLocal();
    ed = { id: v ? v.id : null, parcelas: v ? v.parcelas.map(rascunhoDe) : [] };
    $('venda-titulo').textContent = v ? 'Editar venda' : 'Nova venda';
    $('f-cliente').value = v ? v.cliente : '';
    $('f-produto').value = v ? v.produto : '';
    $('f-data').value = v ? v.dataVenda : hoje;
    $('f-total').value = v ? v.valorTotal.toFixed(2) : '';
    $('f-entrada').value = v ? v.entrada.toFixed(2) : '0';
    $('f-obs').value = v ? v.obs : '';
    const primeira = v ? v.parcelas.find((p) => !p.pago) : null;
    $('g-num').value = '';
    $('g-tipo').value = 'mensal';
    $('g-data').value = primeira && !primeira.semData ? primeira.vencimento : addMesesPreservandoDia(hoje, 1);
    $('g-mes').value = primeira ? primeira.mes : hoje.slice(0, 7);
    atualizarGeradorVisivel();
    esconderErro('erro-venda');
    renderEditorParcelas();
    abrirModal('modal-venda', 'f-cliente');
}

function atualizarGeradorVisivel() {
    const porMes = $('g-tipo').value === 'mes_cada' || $('g-tipo').value === 'mes_mesmo';
    $('g-data-wrap').classList.toggle('vp-hidden', porMes);
    $('g-mes-wrap').classList.toggle('vp-hidden', !porMes);
}

function htmlEditorLinha(p, i) {
    const campo = p.semData
        ? `<input type="month" class="er-mes" value="${esc(p.mes)}" aria-label="Mês da parcela ${i + 1}">`
        : `<input type="date" class="er-data" value="${esc(p.vencimento)}" aria-label="Data da parcela ${i + 1}">`;
    return `<div class="vp-erow" data-i="${i}">
        <span class="vp-erow-n">${i + 1}</span>
        <input type="number" class="er-valor" step="0.01" min="0" inputmode="decimal" value="${esc(p.valor)}" aria-label="Valor da parcela ${i + 1}">
        <select class="er-modo" aria-label="Tipo de vencimento da parcela ${i + 1}">
            <option value="data"${p.semData ? '' : ' selected'}>Data certa</option>
            <option value="mes"${p.semData ? ' selected' : ''}>A combinar no mês</option>
        </select>
        ${campo}
        <button type="button" class="vp-icon-btn er-del" aria-label="Remover parcela ${i + 1}" title="Remover parcela">🗑</button>
    </div>`;
}

function htmlEditorLinhaPaga(p, i) {
    return `<div class="vp-erow paga" data-i="${i}">
        <span class="vp-erow-n" style="color:inherit">${i + 1}</span>
        <span>✓ Recebida em ${formatDateBR(dataRecebimento(p)) || '—'} — ${dinheiro(p.valor)} (pra mexer, use “Desfazer” na lista)</span>
    </div>`;
}

function renderEditorParcelas() {
    const cont = $('parcelas-editor');
    cont.innerHTML = ed.parcelas.length
        ? ed.parcelas.map((p, i) => (p.pago ? htmlEditorLinhaPaga(p, i) : htmlEditorLinha(p, i))).join('')
        : '<div class="vp-vazio">Sem parcelas. Use “Gerar parcelas” ou “Adicionar parcela” — ou deixe assim se foi tudo pago na entrada.</div>';
    atualizarBalanco();
}

function diferencaBalanco() {
    const total = centavos($('f-total').value);
    const ent = centavos($('f-entrada').value);
    const soma = ed.parcelas.reduce((s, p) => s + centavos(p.valor), 0);
    return { total, ent, soma, diff: total - ent - soma };
}

function atualizarBalanco() {
    if (!ed) return;
    const { total, diff } = diferencaBalanco();
    const el = $('balanco');
    el.className = 'vp-balanco';
    if (!total) { el.classList.add('neutro'); el.textContent = 'Informe o valor total'; }
    else if (diff === 0) { el.classList.add('ok'); el.textContent = '✓ Entrada + parcelas fecham com o valor total'; }
    else if (diff > 0) { el.classList.add('falta'); el.textContent = `Faltam ${dinheiro(diff / 100)} pra fechar o total`; }
    else { el.classList.add('passou'); el.textContent = `Passou ${dinheiro(-diff / 100)} do valor total`; }
}

function gerarParcelas() {
    const { total, ent } = diferencaBalanco();
    const pagas = ed.parcelas.filter((p) => p.pago);
    const somaPagas = pagas.reduce((s, p) => s + centavos(p.valor), 0);
    const restante = total - ent - somaPagas;
    const n = parseInt($('g-num').value, 10);
    const tipo = $('g-tipo').value;
    const erro = (m) => mostrarErro('erro-venda', m);
    if (total <= 0) return erro('Informe o valor total antes de gerar as parcelas.');
    if (ent < 0 || ent > total) return erro('A entrada não pode ser maior que o valor total.');
    if (!(n >= 1) || n > 120) return erro('Informe quantas parcelas (de 1 a 120).');
    if (restante <= 0) return erro('Não sobra valor pra parcelar: a entrada e as parcelas já recebidas cobrem o total.');
    let base;
    if (tipo === 'mensal' || tipo === 'semanal' || tipo === 'quinzenal') {
        base = $('g-data').value;
        if (!ehDataISO(base)) return erro('Escolha a data da 1ª parcela.');
    } else {
        base = $('g-mes').value;
        if (!ehMesISO(base)) return erro('Escolha o mês inicial.');
    }
    const novas = dividirCentavos(restante, n).map((c, i) => {
        const p = { valor: (c / 100).toFixed(2), pago: false, dataPagamento: null };
        if (tipo === 'mensal') { p.semData = false; p.vencimento = addMesesPreservandoDia(base, i); p.mes = mesDe(p.vencimento); }
        else if (tipo === 'semanal' || tipo === 'quinzenal') { p.semData = false; p.vencimento = addDias(base, (tipo === 'semanal' ? 7 : 15) * i); p.mes = mesDe(p.vencimento); }
        else { p.semData = true; p.vencimento = null; p.mes = tipo === 'mes_cada' ? addMesesYM(base, i) : base; }
        return p;
    });
    ed.parcelas = [...pagas, ...novas];
    esconderErro('erro-venda');
    renderEditorParcelas();
}

function dividirIgualmente() {
    const idxs = ed.parcelas.map((p, i) => i).filter((i) => !ed.parcelas[i].pago);
    if (!idxs.length) return mostrarErro('erro-venda', 'Não há parcelas em aberto pra dividir.');
    const { total, ent } = diferencaBalanco();
    const somaPagas = ed.parcelas.filter((p) => p.pago).reduce((s, p) => s + centavos(p.valor), 0);
    const restante = total - ent - somaPagas;
    if (restante <= 0) return mostrarErro('erro-venda', 'Não sobra valor pra dividir entre as parcelas.');
    const valores = dividirCentavos(restante, idxs.length);
    idxs.forEach((i, k) => { ed.parcelas[i].valor = (valores[k] / 100).toFixed(2); });
    esconderErro('erro-venda');
    renderEditorParcelas();
}

function adicionarParcela() {
    const { diff } = diferencaBalanco();
    const ultima = ed.parcelas[ed.parcelas.length - 1];
    const p = { valor: diff > 0 ? (diff / 100).toFixed(2) : '', pago: false, dataPagamento: null };
    if (ultima && ultima.semData) {
        Object.assign(p, { semData: true, vencimento: null, mes: ultima.mes });
    } else {
        const ref = ultima && ultima.vencimento ? ultima.vencimento : ($('f-data').value || hojeLocal());
        const venc = addMesesPreservandoDia(ehDataISO(ref) ? ref : hojeLocal(), 1);
        Object.assign(p, { semData: false, vencimento: venc, mes: mesDe(venc) });
    }
    ed.parcelas.push(p);
    esconderErro('erro-venda');
    renderEditorParcelas();
    const linhas = $('parcelas-editor').querySelectorAll('.er-valor');
    if (linhas.length) linhas[linhas.length - 1].focus();
}

function validarEditor() {
    const cliente = $('f-cliente').value.trim();
    const produto = $('f-produto').value.trim();
    const { total, ent, diff } = diferencaBalanco();
    if (!cliente) return 'Informe o nome do cliente.';
    if (!produto) return 'Informe o produto ou a descrição.';
    if (!ehDataISO($('f-data').value)) return 'Informe a data da venda.';
    if (total <= 0) return 'Informe o valor total (maior que zero).';
    if (ent < 0) return 'A entrada não pode ser negativa.';
    if (ent > total) return 'A entrada não pode ser maior que o valor total.';
    for (let i = 0; i < ed.parcelas.length; i++) {
        const p = ed.parcelas[i];
        if (p.pago) continue;
        if (centavos(p.valor) <= 0) return `Parcela ${i + 1}: informe um valor maior que zero.`;
        if (p.semData ? !ehMesISO(p.mes) : !ehDataISO(p.vencimento)) return `Parcela ${i + 1}: ${p.semData ? 'escolha o mês' : 'escolha a data de vencimento'}.`;
    }
    if (diff > 0) return `Faltam ${dinheiro(diff / 100)} pra fechar o valor total. Ajuste as parcelas ou use “Dividir o que falta igualmente”.`;
    if (diff < 0) return `As parcelas passam ${dinheiro(-diff / 100)} do valor total. Ajuste os valores ou use “Dividir o que falta igualmente”.`;
    return null;
}

async function salvarVenda() {
    if (!ed || salvando) return;
    const erro = validarEditor();
    if (erro) return mostrarErro('erro-venda', erro);
    if (!auth.currentUser) return mostrarErro('erro-venda', 'Você precisa estar logado pra salvar.');
    esconderErro('erro-venda');

    const editando = ed.id;
    const produto = $('f-produto').value.trim();
    const total = centavos($('f-total').value) / 100;
    const dataVenda = $('f-data').value;
    const dados = {
        userId: auth.currentUser.uid,
        tipo: 'venda_parcelada',
        cliente: $('f-cliente').value.trim(),
        produto,
        desc: produto,
        valor: total,
        valorTotal: total,
        entrada: centavos($('f-entrada').value) / 100,
        dataVenda,
        data: dataVenda,
        obs: $('f-obs').value.trim(),
        parcelas: serializarParcelas(ed.parcelas),
        atualizadoEm: new Date().toISOString()
    };
    const btn = $('btn-salvar-venda');
    btn.disabled = true;
    await gravar(() => (editando ? updateDoc(doc(db, 'vendas', editando), dados) : addDoc(collection(db, 'vendas'), { ...dados, criadoEm: new Date().toISOString() })),
        editando ? 'Venda atualizada!' : 'Venda cadastrada!');
    btn.disabled = false;
}

/* ---------- registrar recebimento ---------- */
function atualizarRestanteUI() {
    if (!rec) return;
    const v = vendas.find((x) => x.id === rec.vendaId);
    const p = v && v.parcelas[rec.idx];
    if (!p) return;
    const recebido = centavos($('rec-valor').value);
    const orig = centavos(p.valor);
    const parcial = recebido > 0 && recebido < orig;
    $('rec-restante').classList.toggle('vp-hidden', !parcial);
    if (parcial) $('rec-restante-valor').textContent = dinheiro((orig - recebido) / 100);
}

function alternarModo(selId, dataWrapId, mesWrapId) {
    const porMes = $(selId).value === 'mes';
    $(dataWrapId).classList.toggle('vp-hidden', porMes);
    $(mesWrapId).classList.toggle('vp-hidden', !porMes);
}

function abrirReceber(vendaId, idx) {
    const v = vendas.find((x) => x.id === vendaId);
    const p = v && v.parcelas[idx];
    if (!p || p.pago) return;
    const hoje = hojeLocal();
    rec = { vendaId, idx };
    $('rec-resumo').innerHTML = `<b>${esc(v.cliente)}</b> · ${esc(v.produto)}<br>Parcela ${idx + 1}/${v.parcelas.length} · combinado: <b>${dinheiro(p.valor)}</b> — ${esc(rotuloQuando(p, hoje).texto)}`;
    $('rec-valor').value = p.valor.toFixed(2);
    $('rec-data').value = hoje;
    $('rec-data').max = hoje;
    $('rec-rest-modo').value = p.semData ? 'mes' : 'data';
    $('rec-rest-data').value = p.vencimento || hoje;
    $('rec-rest-mes').value = p.mes;
    alternarModo('rec-rest-modo', 'rec-rest-data-wrap', 'rec-rest-mes-wrap');
    esconderErro('erro-receber');
    atualizarRestanteUI();
    abrirModal('modal-receber', 'rec-valor');
}

async function confirmarRecebimento() {
    if (!rec || salvando) return;
    const v = vendas.find((x) => x.id === rec.vendaId);
    const p = v && v.parcelas[rec.idx];
    if (!p) return fecharModais();
    const recebido = centavos($('rec-valor').value);
    const orig = centavos(p.valor);
    const data = $('rec-data').value;
    const erro = (m) => mostrarErro('erro-receber', m);
    if (recebido <= 0) return erro('Informe o valor recebido.');
    if (recebido > orig) return erro(`O valor recebido é maior que a parcela (${dinheiro(orig / 100)}). Se o combinado mudou, ajuste em “Editar venda”.`);
    if (!ehDataISO(data)) return erro('Informe a data do recebimento.');
    if (data > hojeLocal()) return erro('A data do recebimento não pode ser no futuro.');

    const parcelas = v.parcelas.map((x) => ({ ...x }));
    const alvo = parcelas[rec.idx];
    alvo.pago = true;
    alvo.dataPagamento = data;
    alvo.valor = recebido / 100;
    const parcial = recebido < orig;
    if (parcial) {
        const restante = { valor: (orig - recebido) / 100, pago: false, dataPagamento: null };
        if ($('rec-rest-modo').value === 'mes') {
            const m = $('rec-rest-mes').value;
            if (!ehMesISO(m)) return erro('Escolha o mês do restante.');
            Object.assign(restante, { semData: true, vencimento: null, mes: m });
        } else {
            const d = $('rec-rest-data').value;
            if (!ehDataISO(d)) return erro('Escolha a data do restante.');
            Object.assign(restante, { semData: false, vencimento: d, mes: mesDe(d) });
        }
        parcelas.splice(rec.idx + 1, 0, restante);
    }
    esconderErro('erro-receber');
    await gravarParcelas(v.id, parcelas, parcial ? 'Recebimento parcial registrado — o restante continua em aberto.' : 'Recebimento registrado!', false);
}

async function desfazerRecebimento(vendaId, idx) {
    const v = vendas.find((x) => x.id === vendaId);
    const p = v && v.parcelas[idx];
    if (!p || !p.pago) return;
    const ok = await confirmar(`Desfazer o recebimento de ${dinheiro(p.valor)} de ${v.cliente} (parcela ${idx + 1}/${v.parcelas.length})? A parcela volta a ficar em aberto.`,
        { titulo: 'Desfazer recebimento', botao: 'Desfazer', perigo: true });
    if (!ok) return;
    const parcelas = v.parcelas.map((x) => ({ ...x }));
    parcelas[idx].pago = false;
    parcelas[idx].dataPagamento = null;
    await gravarParcelas(v.id, parcelas, 'Recebimento desfeito.', false);
}

/* ---------- remarcar ---------- */
function abrirRemarcar(vendaId, idx) {
    const v = vendas.find((x) => x.id === vendaId);
    const p = v && v.parcelas[idx];
    if (!p || p.pago) return;
    rem = { vendaId, idx };
    $('rem-resumo').innerHTML = `<b>${esc(v.cliente)}</b> · ${esc(v.produto)}<br>Parcela ${idx + 1}/${v.parcelas.length} · <b>${dinheiro(p.valor)}</b> — ${esc(rotuloQuando(p, hojeLocal()).texto)}`;
    $('rem-modo').value = p.semData ? 'mes' : 'data';
    $('rem-data').value = p.vencimento || dataNoMes(p.mes, Number(hojeLocal().slice(8, 10)));
    $('rem-mes').value = p.mes;
    alternarModo('rem-modo', 'rem-data-wrap', 'rem-mes-wrap');
    esconderErro('erro-remarcar');
    abrirModal('modal-remarcar', 'rem-data');
}

async function confirmarRemarcar() {
    if (!rem || salvando) return;
    const v = vendas.find((x) => x.id === rem.vendaId);
    if (!v || !v.parcelas[rem.idx]) return fecharModais();
    const parcelas = v.parcelas.map((x) => ({ ...x }));
    const alvo = parcelas[rem.idx];
    if ($('rem-modo').value === 'mes') {
        const m = $('rem-mes').value;
        if (!ehMesISO(m)) return mostrarErro('erro-remarcar', 'Escolha o mês.');
        Object.assign(alvo, { semData: true, vencimento: null, mes: m });
    } else {
        const d = $('rem-data').value;
        if (!ehDataISO(d)) return mostrarErro('erro-remarcar', 'Escolha a nova data.');
        Object.assign(alvo, { semData: false, vencimento: d, mes: mesDe(d) });
    }
    await gravarParcelas(v.id, parcelas, 'Cobrança remarcada!');
}

/* ---------- excluir venda ---------- */
async function excluirVenda(id) {
    const v = vendas.find((x) => x.id === id);
    if (!v) return;
    const ok = await confirmar(`Excluir a venda de ${v.cliente} (${v.produto})? Isso apaga a venda e todas as parcelas, e não dá pra desfazer.`,
        { titulo: 'Excluir venda', botao: 'Excluir', perigo: true });
    if (!ok) return;
    await gravar(() => deleteDoc(doc(db, 'vendas', id)), 'Venda excluída.');
}

/* ---------- importar lista (texto copiado de uma anotação: "Nome: valor" + "Recado: ...") ---------- */
const RE_MES_NOME = '(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)';
const NUM_MES = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
const ROTULO_FREQ = { semanal: 'toda semana', quinzenal: 'a cada 15 dias', mensal: 'todo mês' };
const PRODUTO_IMPORTADO = 'Saldo a receber (importado)';
const LIMITE_IMPORTAR = 300;

// "16.775" → 1677500 · "3234,75" → 323475 · "R$ 1.234,56" → 123456 (em centavos; null se não for um valor)
function lerValorCentavos(s) {
    let t = String(s || '').replace(/[^\d.,]/g, '').replace(/^[.,]+|[.,]+$/g, '');
    if (!t) return null;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, ''); // ponto de milhar (16.775)
    const c = Math.round(Number(t) * 100);
    return Number.isFinite(c) && c > 0 ? c : null;
}

// Data sem ano ("12/09"): fica com o ano em que a data cai mais perto de hoje (12/09 em out/2026 = 2026; 05/01 = 2027)
function dataMaisProxima(dia, m, hoje) {
    const ano = Number(hoje.slice(0, 4));
    let melhor = null;
    for (const a of [ano - 1, ano, ano + 1]) {
        const iso = `${a}-${pad2(m)}-${pad2(dia)}`;
        if (!ehDataISO(iso)) continue;
        const dist = Math.abs(diasEntre(hoje, iso));
        if (!melhor || dist < melhor.dist || (dist === melhor.dist && iso > melhor.iso)) melhor = { iso, dist };
    }
    return melhor && melhor.iso;
}
function mesMaisProximo(m, hoje) { // "mês 9" sem ano (empate: o futuro)
    const ano = Number(hoje.slice(0, 4));
    const atual = ano * 12 + Number(hoje.slice(5, 7));
    let melhor = null;
    for (const a of [ano - 1, ano, ano + 1]) {
        const dist = Math.abs(a * 12 + m - atual);
        if (!melhor || dist < melhor.dist || (dist === melhor.dist && a > melhor.a)) melhor = { a, dist };
    }
    return `${melhor.a}-${pad2(m)}`;
}
function montarData(dia, m, anoTxt, hoje) {
    if (!(m >= 1 && m <= 12 && dia >= 1 && dia <= 31)) return null;
    if (!anoTxt) return dataMaisProxima(dia, m, hoje);
    const iso = `${anoTxt.length === 2 ? 2000 + Number(anoTxt) : Number(anoTxt)}-${pad2(m)}-${pad2(dia)}`;
    return ehDataISO(iso) ? iso : null;
}
function proximaOcorrenciaDia(dia, hoje) { // "dia 15": o próximo dia 15 a partir de hoje
    let ym = hoje.slice(0, 7);
    for (let i = 0; i < 14; i++, ym = addMesesYM(ym, 1)) {
        const iso = dataNoMes(ym, dia);
        if (iso >= hoje) return iso;
    }
    return dataNoMes(hoje.slice(0, 7), dia);
}
const dataDaParcela = (inicio, freq, i) => (freq === 'semanal' ? addDias(inicio, 7 * i) : freq === 'quinzenal' ? addDias(inicio, 15 * i) : addMesesPreservandoDia(inicio, i));

// Procura no "recado" datas, meses, periodicidade, quantidade e valor da parcela. Cada trecho entendido é apagado do texto
// pra os padrões seguintes não lerem a mesma coisa de novo (o callback devolve false quando o trecho não era o que parecia).
function lerRecado(txt, hoje) {
    const original = String(txt || '').trim();
    let t = ` ${semAcento(original).replace(/\s+/g, ' ')} `;
    const r = { vazio: !original, cortado: /\d\s+de$/i.test(original), datas: [], meses: [], dias: [], freq: null, qtd: null, valorParcelaC: null };
    const achar = (re, fn) => { t = t.replace(re, (trecho, ...g) => (fn(...g) === false ? trecho : ' '.repeat(trecho.length))); };
    const freqDe = (f) => (f.startsWith('semana') ? 'semanal' : f.startsWith('quinzena') ? 'quinzenal' : 'mensal');

    // valor de cada parcela + periodicidade: "200 semanalmente", "300 por mês"
    achar(/(?<!dia\s)(?<![\d/.,])(\d[\d.,]*)\s*(?:reais\s*)?(semanal(?:mente)?|quinzenal(?:mente)?|mensal(?:mente)?)/g, (v, f) => {
        const c = lerValorCentavos(v);
        if (!c) return false;
        r.valorParcelaC = c; r.freq = freqDe(f);
    });
    achar(/(?<!dia\s)(?<![\d/.,])(\d[\d.,]*)\s*(?:reais\s*)?(?:por|ao|\/)\s*(semana|quinzena|mes)\b/g, (v, f) => {
        const c = lerValorCentavos(v);
        if (!c) return false;
        r.valorParcelaC = c; r.freq = freqDe(f);
    });
    // periodicidade solta
    achar(/\b(?:semanal(?:mente)?|toda\s+semana|todas\s+as\s+semanas|por\s+semana|a\s+cada\s+semana)\b/g, () => { r.freq = r.freq || 'semanal'; });
    achar(/\b(?:quinzenal(?:mente)?|a\s+cada\s+(?:15|quinze)\s+dias|de\s+15\s+em\s+15(?:\s+dias)?)\b/g, () => { r.freq = r.freq || 'quinzenal'; });
    achar(/\b(?:mensal(?:mente)?|todo\s+mes|todos\s+os\s+meses|por\s+mes|a\s+cada\s+mes)\b/g, () => { r.freq = r.freq || 'mensal'; });

    // mês/ano: "mês 10/2026", "10/2026"
    achar(/(?<![\d/.])(?:mes\s*(?:de\s*)?)?(0?[1-9]|1[0-2])\s*\/\s*(20\d{2})(?!\d)/g, (m, a) => { r.meses.push(`${a}-${pad2(m)}`); });
    // "dia 20 mês 10" (ano opcional)
    achar(/\bdia\s*(\d{1,2})\s*(?:do\s*)?mes\s*(?:de\s*)?(\d{1,2})(?:\s*(?:de|\/)\s*(20\d{2}))?(?!\d)/g, (d, m, a) => {
        const iso = montarData(Number(d), Number(m), a, hoje);
        if (!iso) return false;
        r.datas.push(iso);
    });
    // 12/09 · 05.11 · 15/10/2026 · 15/10/26
    achar(/(?<![\d/.,])(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}|\d{2}))?(?![\d/])/g, (d, m, a) => {
        const iso = montarData(Number(d), Number(m), a, hoje);
        if (!iso) return false;
        r.datas.push(iso);
    });
    // "5 de novembro", "dia 5 novembro de 2026"
    achar(new RegExp(`(?<!\\d)(\\d{1,2})\\s*(?:de\\s+)?${RE_MES_NOME}(?:\\s*(?:de\\s*)?(20\\d{2}))?`, 'g'), (d, nome, a) => {
        const iso = montarData(Number(d), NUM_MES[nome], a, hoje);
        if (!iso) return false;
        r.datas.push(iso);
    });
    // mês solto: "mês 9" e "outubro"
    achar(/\bmes\s*(?:de\s*)?(\d{1,2})(?!\d)(?!\s*[/.]\s*\d)/g, (m) => {
        if (!(m >= 1 && m <= 12)) return false;
        r.meses.push(mesMaisProximo(Number(m), hoje));
    });
    achar(new RegExp(`\\b${RE_MES_NOME}\\b(?:\\s*(?:de\\s*)?(20\\d{2}))?`, 'g'), (nome, a) => { r.meses.push(a ? `${a}-${pad2(NUM_MES[nome])}` : mesMaisProximo(NUM_MES[nome], hoje)); });
    // dia solto: "dia 15"
    achar(/\bdia\s*(\d{1,2})(?!\d)/g, (d) => {
        if (!(d >= 1 && d <= 31)) return false;
        r.dias.push(Number(d));
    });

    // quantidade e valor da parcela: "3x de 500", "3 parcelas", "parcelas de 500"
    achar(/(?<!dia\s)(?<![\d/.,])(\d{1,3})\s*x\s*(?:de\s*)?(?:r\$\s*)?(\d[\d.,]*)/g, (n, v) => {
        const c = lerValorCentavos(v);
        if (!c) return false;
        r.qtd = Number(n); r.valorParcelaC = c;
    });
    achar(/(?<!dia\s)(?<![\d/.,])(\d{1,3})\s*(?:x|vezes|parcelas?|prestacoes?|pagamentos?)(?![a-z])/g, (n) => { r.qtd = Number(n); });
    achar(/parcelas?\s*(?:de\s*)?(?:r\$\s*)?(\d[\d.,]*)/g, (v) => {
        const c = lerValorCentavos(v);
        if (!c) return false;
        r.valorParcelaC = c;
    });
    // recado cortado no fim da linha: "3 de" (ou "3 de 1.000")
    achar(/(?<!dia\s)(?<![\d/.,])(\d{1,3})\s+de(?:\s+(?:r\$\s*)?(\d[\d.,]*))?\s*$/g, (n, v) => {
        r.qtd = r.qtd || Number(n);
        const c = v && lerValorCentavos(v);
        if (c) r.valorParcelaC = r.valorParcelaC || c;
    });
    return r;
}

// Transforma o que o recado disse em parcelas. O que não deu pra saber vira "suposição" (fica avisado na venda).
function montarPlano(totalC, r, hoje) {
    const suposicoes = [];
    const mesAtual = hoje.slice(0, 7);
    const meses = [...new Set(r.meses)].sort();
    let datas = [...new Set(r.datas)].sort();
    if (!datas.length && r.dias.length === 1) {
        if (!meses.length) datas = [proximaOcorrenciaDia(r.dias[0], hoje)];
        else if (meses.length === 1) { datas = [dataNoMes(meses[0], r.dias[0])]; meses.length = 0; }
    }
    const comData = (iso, valorC) => ({ valorC, semData: false, vencimento: iso, mes: mesDe(iso) });
    const semDataNoMes = (ym, valorC) => ({ valorC, semData: true, vencimento: null, mes: ym });
    const qtd = r.qtd >= 1 && r.qtd <= 120 ? r.qtd : null;
    const quantas = () => (r.valorParcelaC ? Math.ceil(totalC / r.valorParcelaC) : qtd); // null = o recado não diz
    // n parcelas: com valor fixo no recado a última leva o que sobra; sem ele, partes iguais
    const dividir = (n) => {
        const fixo = r.valorParcelaC;
        if (fixo && fixo * (n - 1) < totalC) {
            const lista = Array(n).fill(fixo);
            lista[n - 1] = totalC - fixo * (n - 1);
            return { valores: lista, porFixo: true };
        }
        return { valores: dividirCentavos(totalC, n), porFixo: false };
    };

    let parcelas = null;
    let freqUsada = null;
    if (datas.length >= 2) {
        const { valores, porFixo } = dividir(datas.length);
        if (!porFixo) suposicoes.push('O recado não diz quanto vem em cada data — dividi o valor igualmente.');
        parcelas = valores.map((v, i) => comData(datas[i], v));
    } else if (datas.length === 1) {
        let n = quantas();
        if (n > 120) { suposicoes.push(`O recado levaria a ${n} parcelas — coloquei 1 parcela com o valor todo. Confira.`); n = 1; }
        if (n > 1) {
            freqUsada = r.freq || 'mensal';
            const { valores, porFixo } = dividir(n);
            parcelas = valores.map((v, i) => comData(dataDaParcela(datas[0], freqUsada, i), v));
            if (r.cortado && !porFixo) suposicoes.push(`O recado parece cortado (“…${r.qtd} de”) — montei ${n} parcelas iguais, uma por mês. Confira.`);
        } else {
            parcelas = [comData(datas[0], totalC)];
            if (r.freq && n === null) suposicoes.push(`O recado diz “${r.freq}”, mas não diz quantas parcelas — coloquei 1 parcela com o valor todo. Pra dividir, edite a venda e use “Gerar parcelas”.`);
        }
    } else if (meses.length >= 2) {
        suposicoes.push('O recado não diz quanto vem em cada mês — dividi o valor igualmente.');
        parcelas = dividirCentavos(totalC, meses.length).map((v, i) => semDataNoMes(meses[i], v));
    } else if (meses.length === 1) {
        const n = quantas();
        if (n > 1 && n <= 120) parcelas = dividir(n).valores.map((v, i) => semDataNoMes(addMesesYM(meses[0], i), v));
        else parcelas = [semDataNoMes(meses[0], totalC)];
    }
    if (!parcelas) {
        parcelas = [semDataNoMes(mesAtual, totalC)];
        suposicoes.push(r.vazio
            ? `Sem recado — coloquei como “a combinar” em ${nomeMes(mesAtual, true)}. Ajuste o mês se precisar.`
            : `Não consegui entender o recado — coloquei como “a combinar” em ${nomeMes(mesAtual, true)}. Confira e ajuste.`);
    }
    if (parcelas.reduce((s, p) => s + p.valorC, 0) !== totalC || parcelas.some((p) => !(p.valorC > 0))) {
        parcelas = [semDataNoMes(mesAtual, totalC)];
        freqUsada = null;
        suposicoes.push(`Não consegui montar as parcelas desse recado — coloquei como “a combinar” em ${nomeMes(mesAtual, true)}. Confira e ajuste.`);
    }

    const vencidas = parcelas.filter((p) => (p.semData ? p.mes < mesAtual : p.vencimento < hoje)).length;
    const notas = vencidas
        ? [`${plural(vencidas, 'parcela já venceu', 'parcelas já venceram')} — ${vencidas === 1 ? 'vai aparecer como atrasada' : 'vão aparecer como atrasadas'}. Se já recebeu, é só usar “Recebi” depois.`]
        : [];
    return { parcelas, suposicoes, notas, freq: freqUsada };
}

function descreverPlano(parcelas, freq) {
    const n = parcelas.length;
    const v = (p) => dinheiro(p.valorC / 100);
    const iguais = parcelas.every((p) => p.valorC === parcelas[0].valorC);
    const soUltimaDifere = n > 1 && parcelas.slice(0, -1).every((p) => p.valorC === parcelas[0].valorC);
    let valores;
    if (n === 1) valores = `1 parcela de ${v(parcelas[0])}`;
    else if (iguais) valores = `${n} parcelas de ${v(parcelas[0])}`;
    else if (soUltimaDifere) valores = `${n - 1} ${n - 1 === 1 ? 'parcela' : 'parcelas'} de ${v(parcelas[0])} + 1 de ${v(parcelas[n - 1])}`;
    else valores = `${n} parcelas (de ${v(parcelas[0])} a ${v(parcelas[n - 1])})`;
    let quando;
    if (parcelas.every((p) => p.semData)) {
        const ms = [...new Set(parcelas.map((p) => p.mes))];
        quando = ms.length === 1 ? `a combinar em ${nomeMes(ms[0], true)}` : `a combinar de ${nomeMes(ms[0], true)} a ${nomeMes(ms[ms.length - 1], true)}`;
    } else {
        const ds = parcelas.map((p) => formatDateBR(p.vencimento));
        if (n === 1) quando = `vence em ${ds[0]}`;
        else if (n <= 4) quando = `vencem em ${ds.join(', ')}`;
        else quando = `de ${ds[0]} a ${ds[n - 1]}${freq ? ` (${ROTULO_FREQ[freq]})` : ''}`;
    }
    return `${valores} — ${quando}`;
}

function limparNome(s) {
    let n = String(s).replace(/\s+/g, ' ').replace(/[\s:\-–—]+$/, '').trim();
    if (n.length >= 4 && n === n.toUpperCase() && n !== n.toLowerCase()) n = n.toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()); // "WENDEL FONTE" → "Wendel Fonte"
    return n;
}

// Lê o texto colado. Cada pessoa é uma linha "Nome: valor"; "Recado: ..." (ou qualquer linha solta logo depois) é o combinado dela.
function lerListaRecebiveis(texto) {
    const itens = [];
    let atual = null;
    const juntar = (a, b) => [a, b].filter(Boolean).join(' ');
    for (const bruto of String(texto || '').split(/\r?\n/)) {
        if (/^[\s=\-<>*_~·•.→]*$/.test(bruto)) continue; // linha em branco ou só enfeite (=->-----<-=)
        const linha = bruto.replace(/^[\s=\-<>*•·→]+/, '').trim();
        if (!linha) continue;
        const rec = linha.match(/^(?:recados?|obs\.?|observa[cç][aã]o|observa[cç][oõ]es|nota|anota[cç][aã]o|detalhes?)\s*:\s*(.*)$/i);
        if (rec) { if (atual) atual.recado = juntar(atual.recado, rec[1].trim()); continue; }
        if (/^total\b/i.test(linha)) { atual = null; continue; }
        const ent = linha.match(/^(.+?)\s*:\s*(?:R\$\s*)?(\d[\d.,]*)\s*(.*)$/i);
        const totalC = ent && lerValorCentavos(ent[2]);
        if (totalC) {
            atual = { cliente: limparNome(ent[1]), totalC, recado: ent[3].replace(/^[\s=\-<>*→]+/, '').trim() };
            itens.push(atual);
            continue;
        }
        if (atual) atual.recado = juntar(atual.recado, linha);
    }
    return itens;
}

const chaveNome = (s) => semAcento(s).replace(/[^a-z0-9]+/g, ' ').trim();
function mesmoCliente(a, b) {
    const x = chaveNome(a), y = chaveNome(b);
    return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `)); // "Wendel" ≈ "Wendel Fonte"
}
// Já tem venda em aberto desse cliente? "provável" = mesmo valor (deve ser a mesma venda)
function acharParecida(cliente, totalC) {
    const hoje = hojeLocal();
    let achada = null;
    for (const v of vendas) {
        if (!mesmoCliente(v.cliente, cliente)) continue;
        const aberto = resumoVenda(v, hoje).aberto;
        if (aberto <= 0) continue;
        const provavel = aberto === totalC || centavos(v.valorTotal) === totalC;
        if (!achada || (provavel && !achada.provavel)) achada = { cliente: v.cliente, aberto, provavel };
    }
    return achada;
}

function prepararImportacao(texto) {
    const hoje = hojeLocal();
    return lerListaRecebiveis(texto).map((e) => {
        const plano = montarPlano(e.totalC, lerRecado(e.recado, hoje), hoje);
        const parecida = acharParecida(e.cliente, e.totalC);
        return { ...e, ...plano, descricao: descreverPlano(plano.parcelas, plano.freq), parecida, marcado: !(parecida && parecida.provavel) };
    });
}

function htmlItemImportacao(i, k) {
    const avisos = i.suposicoes.map((a) => `<span class="vp-imp-aviso">⚠ ${esc(a)}</span>`).join('');
    const notas = i.notas.map((a) => `<span class="vp-imp-nota">ℹ ${esc(a)}</span>`).join('');
    let dup = '';
    if (i.parecida) {
        dup = i.parecida.provavel
            ? `<span class="vp-imp-dup">🔁 Já existe “${esc(i.parecida.cliente)}” com ${dinheiro(i.parecida.aberto / 100)} em aberto — provavelmente é a mesma venda, então deixei desmarcada. Marque se for outra.</span>`
            : `<span class="vp-imp-nota">🔁 Já existe uma venda de “${esc(i.parecida.cliente)}” com ${dinheiro(i.parecida.aberto / 100)} em aberto — confira pra não duplicar.</span>`;
    }
    return `<div class="vp-imp-item${i.marcado ? '' : ' desmarcado'}${i.suposicoes.length ? ' aviso' : ''}" data-k="${k}">
        <input type="checkbox" class="checkbox-custom vp-imp-ck" id="imp-ck-${k}" data-k="${k}"${i.marcado ? ' checked' : ''}>
        <label class="vp-imp-corpo" for="imp-ck-${k}">
            <span class="vp-imp-topo"><b>${esc(i.cliente)}</b><span class="vp-imp-valor">${dinheiro(i.totalC / 100)}</span></span>
            <span class="vp-imp-plano">${esc(i.descricao)}</span>
            ${i.recado ? `<span class="vp-imp-recado">Recado: “${esc(i.recado)}”</span>` : ''}
            ${avisos}${notas}${dup}
        </label>
    </div>`;
}

function atualizarResumoImportacao() {
    if (!imp) return;
    const marcados = imp.itens.filter((i) => i.marcado);
    const totalC = marcados.reduce((s, i) => s + i.totalC, 0);
    $('imp-resumo').innerHTML = `Achei <b>${plural(imp.itens.length, 'pessoa', 'pessoas')}</b>. Confira como entendi cada uma e desmarque as que não quer importar.<br>Marcadas: <b>${marcados.length}</b> · total <b>${dinheiro(totalC / 100)}</b>`;
    const btn = $('btn-imp-confirmar');
    btn.textContent = marcados.length ? `Importar ${plural(marcados.length, 'venda', 'vendas')}` : 'Nada marcado';
    btn.disabled = !marcados.length;
    $('imp-lista').querySelectorAll('.vp-imp-item').forEach((el) => el.classList.toggle('desmarcado', !imp.itens[Number(el.dataset.k)].marcado));
}

function mostrarPassoImportar(n) {
    $('imp-passo1').classList.toggle('vp-hidden', n !== 1);
    $('imp-passo2').classList.toggle('vp-hidden', n !== 2);
    $('btn-imp-analisar').classList.toggle('vp-hidden', n !== 1);
    $('btn-imp-voltar').classList.toggle('vp-hidden', n !== 2);
    $('btn-imp-confirmar').classList.toggle('vp-hidden', n !== 2);
    $('importar-titulo').textContent = n === 1 ? 'Importar lista de recebimentos' : 'Confira antes de importar';
    esconderErro('erro-importar');
}

function abrirImportar(texto = '') {
    if (!carregado) return toast('Espere a lista carregar um instante e tente de novo.');
    imp = null;
    $('imp-texto').value = texto;
    mostrarPassoImportar(1);
    abrirModal('modal-importar', 'imp-texto');
    if (texto) analisarLista();
}

function analisarLista() {
    const texto = $('imp-texto').value;
    if (!texto.trim()) return mostrarErro('erro-importar', 'Cole a lista primeiro.');
    const itens = prepararImportacao(texto);
    if (!itens.length) return mostrarErro('erro-importar', 'Não achei nenhuma linha no formato “Nome: valor”. Cole a lista do jeito que está na anotação.');
    if (itens.length > LIMITE_IMPORTAR) return mostrarErro('erro-importar', `A lista tem ${itens.length} pessoas — importe no máximo ${LIMITE_IMPORTAR} por vez.`);
    imp = { itens };
    $('imp-lista').innerHTML = itens.map(htmlItemImportacao).join('');
    atualizarResumoImportacao();
    mostrarPassoImportar(2);
}

const obsDaImportacao = (i, hoje) => [`Importado da lista em ${formatDateBR(hoje)}.`, i.recado && `Recado da lista: ${i.recado}`, ...i.suposicoes.map((s) => `⚠ ${s}`)].filter(Boolean).join('\n');

async function importarLista() {
    if (!imp || salvando) return;
    const marcados = imp.itens.filter((i) => i.marcado);
    if (!marcados.length) return;
    if (!auth.currentUser) return mostrarErro('erro-importar', 'Você precisa estar logado pra importar.');
    esconderErro('erro-importar');
    const uid = auth.currentUser.uid;
    const hoje = hojeLocal();
    const agora = new Date().toISOString();
    const comAviso = marcados.filter((i) => i.suposicoes.length).length;
    const btn = $('btn-imp-confirmar');
    btn.disabled = true;
    const ok = await gravar(async () => {
        const lote = writeBatch(db); // tudo ou nada: se falhar, nada entra pela metade
        marcados.forEach((i) => {
            const total = i.totalC / 100;
            lote.set(doc(collection(db, 'vendas')), {
                userId: uid, tipo: 'venda_parcelada', cliente: i.cliente, produto: PRODUTO_IMPORTADO, desc: PRODUTO_IMPORTADO,
                valor: total, valorTotal: total, entrada: 0, dataVenda: hoje, data: hoje, obs: obsDaImportacao(i, hoje),
                parcelas: serializarParcelas(i.parcelas.map((p) => ({ valor: p.valorC / 100, semData: p.semData, vencimento: p.vencimento, mes: p.mes, pago: false, dataPagamento: null }))),
                criadoEm: agora, atualizadoEm: agora
            });
        });
        await lote.commit();
    }, `${plural(marcados.length, 'venda importada', 'vendas importadas')}!${comAviso ? ' Abra as que têm ⚠ na observação pra conferir.' : ''}`);
    if (!ok && imp) btn.disabled = false;
}

// Link de importação: vendas_parceladas.html#importar=<texto da lista codificado>. Só preenche e mostra a conferência; nunca grava sozinho.
let textoDoLink = null;
function lerTextoDoLink() {
    const m = location.hash.match(/^#importar=([\s\S]+)$/);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return null; }
}

/* ---------- eventos ---------- */
function ligarEventos() {
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-acao]');
        if (!el) return;
        const { acao, venda, idx } = el.dataset;
        switch (acao) {
            case 'mes-anterior': mes = addMesesYM(mes, -1); renderAll(); break;
            case 'mes-proximo': mes = addMesesYM(mes, 1); renderAll(); break;
            case 'mes-hoje': mes = hojeLocal().slice(0, 7); renderAll(); break;
            case 'nova-venda': abrirEditor(null); break;
            case 'importar-lista': abrirImportar(); break;
            case 'imp-voltar': mostrarPassoImportar(1); $('imp-texto').focus(); break;
            case 'editar-venda': abrirEditor(vendas.find((x) => x.id === venda)); break;
            case 'excluir-venda': excluirVenda(venda); break;
            case 'receber': abrirReceber(venda, Number(idx)); break;
            case 'remarcar': abrirRemarcar(venda, Number(idx)); break;
            case 'desfazer': desfazerRecebimento(venda, Number(idx)); break;
            case 'alternar-recebidas': mostrarRecebidas = !mostrarRecebidas; renderQuadro(); break;
            case 'filtro': filtro = el.dataset.filtro; renderVendas(); break;
            case 'alternar-venda': {
                const aberta = el.parentElement.classList.toggle('aberta');
                el.setAttribute('aria-expanded', String(aberta));
                if (aberta) expandidas.add(venda); else expandidas.delete(venda);
                break;
            }
            case 'fechar-modal': fecharModais(); break;
            case 'confirm-nao': fecharModais(); break;
            case 'confirm-sim': { const r = confirmResolver; confirmResolver = null; fecharModais(); if (r) r(true); break; }
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') fecharModais();
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.vp-venda-head')) { e.preventDefault(); e.target.click(); }
    });

    $('vp-overlay').addEventListener('click', () => { if (MODAIS_LONGOS.every((id) => $(id).classList.contains('vp-hidden'))) fecharModais(); });
    $('busca').addEventListener('input', (e) => { busca = e.target.value; renderVendas(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) renderAll(); });

    // editor
    $('g-tipo').addEventListener('change', atualizarGeradorVisivel);
    $('btn-gerar').addEventListener('click', () => ed && gerarParcelas());
    $('btn-dividir').addEventListener('click', () => ed && dividirIgualmente());
    $('btn-add-parcela').addEventListener('click', () => ed && adicionarParcela());
    $('btn-salvar-venda').addEventListener('click', salvarVenda);
    ['f-total', 'f-entrada'].forEach((id) => $(id).addEventListener('input', atualizarBalanco));

    const editor = $('parcelas-editor');
    editor.addEventListener('input', (e) => {
        const row = e.target.closest('.vp-erow');
        const p = row && ed && ed.parcelas[Number(row.dataset.i)];
        if (!p) return;
        if (e.target.classList.contains('er-valor')) { p.valor = e.target.value; atualizarBalanco(); }
        else if (e.target.classList.contains('er-data')) { p.vencimento = e.target.value; p.mes = mesDe(e.target.value); }
        else if (e.target.classList.contains('er-mes')) { p.mes = e.target.value; }
    });
    editor.addEventListener('change', (e) => {
        const row = e.target.closest('.vp-erow');
        const p = row && ed && ed.parcelas[Number(row.dataset.i)];
        if (!p || !e.target.classList.contains('er-modo')) return;
        if (e.target.value === 'mes') {
            p.semData = true;
            p.mes = ehMesISO(p.mes) ? p.mes : (mesDe(p.vencimento) || hojeLocal().slice(0, 7));
        } else {
            const diaPreferido = p.vencimento && mesDe(p.vencimento) === p.mes ? Number(p.vencimento.slice(8, 10)) : Number(($('f-data').value || hojeLocal()).slice(8, 10));
            p.semData = false;
            p.vencimento = dataNoMes(ehMesISO(p.mes) ? p.mes : hojeLocal().slice(0, 7), diaPreferido);
            p.mes = mesDe(p.vencimento);
        }
        renderEditorParcelas();
    });
    editor.addEventListener('click', (e) => {
        const del = e.target.closest('.er-del');
        const row = e.target.closest('.vp-erow');
        if (!del || !row || !ed) return;
        ed.parcelas.splice(Number(row.dataset.i), 1);
        renderEditorParcelas();
    });

    // importar lista
    $('btn-imp-analisar').addEventListener('click', analisarLista);
    $('btn-imp-confirmar').addEventListener('click', importarLista);
    $('imp-lista').addEventListener('change', (e) => {
        const item = imp && imp.itens[Number(e.target.dataset && e.target.dataset.k)];
        if (!item) return;
        item.marcado = e.target.checked;
        atualizarResumoImportacao();
    });

    // Enter confirma nos modais pequenos (no editor não: é um formulário longo, Enter acidental salvaria cedo demais)
    [['modal-receber', 'btn-confirmar-receber'], ['modal-remarcar', 'btn-confirmar-remarcar']].forEach(([modalId, btnId]) => {
        $(modalId).addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); $(btnId).click(); }
        });
    });

    // recebimento / remarcar
    $('rec-valor').addEventListener('input', atualizarRestanteUI);
    $('rec-rest-modo').addEventListener('change', () => alternarModo('rec-rest-modo', 'rec-rest-data-wrap', 'rec-rest-mes-wrap'));
    $('btn-confirmar-receber').addEventListener('click', confirmarRecebimento);
    $('rem-modo').addEventListener('change', () => alternarModo('rem-modo', 'rem-data-wrap', 'rem-mes-wrap'));
    $('btn-confirmar-remarcar').addEventListener('click', confirmarRemarcar);
}

/* ---------- início ---------- */
function init() {
    textoDoLink = lerTextoDoLink();
    ligarEventos();
    renderAll();
    onAuthStateChanged(auth, (user) => {
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        if (!user) {
            $('vp-aviso-login').classList.remove('vp-hidden');
            vendas = [];
            carregado = true;
            renderAll();
            return;
        }
        $('vp-aviso-login').classList.add('vp-hidden');
        const q = query(collection(db, 'vendas'), where('userId', '==', user.uid));
        unsubscribe = onSnapshot(q, (snapshot) => {
            vendas = snapshot.docs
                .map((d) => ({ id: d.id, ...d.data() }))
                .filter((d) => d.tipo === 'venda_parcelada')
                .map((d) => normalizarVenda(d.id, d));
            carregado = true;
            renderAll();
            if (textoDoLink) { // veio de um link de importação: abre a conferência (já com as vendas carregadas, pra achar duplicadas)
                const texto = textoDoLink;
                textoDoLink = null;
                history.replaceState(null, '', location.pathname + location.search);
                abrirImportar(texto);
            }
        }, (error) => {
            console.error('Erro ao escutar vendas:', error);
            carregado = true;
            renderAll();
            toast('O Firebase bloqueou a leitura. Confira as Regras de Segurança (Rules) do Firestore.', 'erro');
        });
    });
}

init();
