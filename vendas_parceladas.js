import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, updateDoc, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
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
        cont.innerHTML = '<div class="vp-vazio">Nenhuma venda cadastrada ainda. Clique em “＋ Nova venda” pra começar.</div>';
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
const MODAIS = ['modal-venda', 'modal-receber', 'modal-remarcar', 'modal-confirm'];
let ed = null;   // rascunho da venda aberta no editor
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
    ed = null; rec = null; rem = null;
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
    if (tipo === 'mensal' || tipo === 'semanal') {
        base = $('g-data').value;
        if (!ehDataISO(base)) return erro('Escolha a data da 1ª parcela.');
    } else {
        base = $('g-mes').value;
        if (!ehMesISO(base)) return erro('Escolha o mês inicial.');
    }
    const novas = dividirCentavos(restante, n).map((c, i) => {
        const p = { valor: (c / 100).toFixed(2), pago: false, dataPagamento: null };
        if (tipo === 'mensal') { p.semData = false; p.vencimento = addMesesPreservandoDia(base, i); p.mes = mesDe(p.vencimento); }
        else if (tipo === 'semanal') { p.semData = false; p.vencimento = addDias(base, 7 * i); p.mes = mesDe(p.vencimento); }
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

    $('vp-overlay').addEventListener('click', () => { if ($('modal-venda').classList.contains('vp-hidden')) fecharModais(); });
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
        }, (error) => {
            console.error('Erro ao escutar vendas:', error);
            carregado = true;
            renderAll();
            toast('O Firebase bloqueou a leitura. Confira as Regras de Segurança (Rules) do Firestore.', 'erro');
        });
    });
}

init();
