import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, deleteDoc, doc, updateDoc, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyAfb_D2zgx0ekh_OoZoCIMVVbWFDjrCc4M",
    authDomain: "cash-c56e8.firebaseapp.com",
    projectId: "cash-c56e8",
    storageBucket: "cash-c56e8.firebasestorage.app",
    messagingSenderId: "169106049481",
    appId: "1:169106049481:web:a72f58bf916d9f14eb0018"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// State
let vendas = [];
let currentEditId = null;
let currentMonth = new Date().toISOString().substring(0, 7); // YYYY-MM

// Helper functions for dates
function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function getDaysInMonth(year, month) {
    const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return days[month];
}

function addMonthsPreservingDay(dateStr, monthsToAdd) {
    // dateStr in YYYY-MM-DD
    const [y, m, d] = dateStr.split('-').map(Number);
    let newMonth = m - 1 + monthsToAdd;
    let newYear = y + Math.floor(newMonth / 12);
    newMonth = newMonth % 12;
    
    const targetDay = d;
    const maxDays = getDaysInMonth(newYear, newMonth);
    const finalDay = Math.min(targetDay, maxDays);
    
    return `${newYear}-${String(newMonth + 1).padStart(2, '0')}-${String(finalDay).padStart(2, '0')}`;
}

function calculateInstallments(valorTotal, entrada, numParcelas, primeiraParcelaData) {
    if (numParcelas <= 0) return [];
    
    const saldo = valorTotal - entrada;
    const parcelaBase = parseFloat((saldo / numParcelas).toFixed(2));
    const parcelas = [];
    
    let soma = 0;
    for (let i = 0; i < numParcelas - 1; i++) {
        parcelas.push({
            numero: i + 1,
            valor: parcelaBase,
            vencimento: addMonthsPreservingDay(primeiraParcelaData, i),
            pago: false,
            dataPagamento: null
        });
        soma += parcelaBase;
    }
    
    const ultimaParcela = parseFloat((saldo - soma).toFixed(2));
    parcelas.push({
        numero: numParcelas,
        valor: ultimaParcela,
        vencimento: addMonthsPreservingDay(primeiraParcelaData, numParcelas - 1),
        pago: false,
        dataPagamento: null
    });
    
    return parcelas;
}

// UI Functions
export function init() {
    setupListeners();
    document.getElementById('filter-month').value = currentMonth;
    
    onAuthStateChanged(auth, (user) => {
        if (user) {
            console.log("Usuário logado, carregando vendas parceladas...");
            const q = query(collection(db, "vendas"), where("userId", "==", user.uid));
            onSnapshot(q, (snapshot) => {
                const todas = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                vendas = todas.filter(item => item.tipo === "venda_parcelada");
                vendas.sort((a, b) => b.dataVenda.localeCompare(a.dataVenda));
                renderAll();
            }, (error) => {
                console.error("Erro ao escutar vendas:", error);
                alert("Erro ao buscar dados: " + error.message);
            });
        } else {
            console.log("Usuário não logado!");
            alert("Você precisa estar logado para ver as vendas parceladas.");
        }
    });
}

function setupListeners() {
    document.getElementById('btn-save').addEventListener('click', saveVenda);
    document.getElementById('btn-cancel').addEventListener('click', resetForm);
    document.getElementById('tipo-venda').addEventListener('change', toggleFormFields);
    document.getElementById('filter-month').addEventListener('change', (e) => {
        currentMonth = e.target.value;
        renderAll();
    });
    
    const formInputs = ['valor-total', 'entrada', 'num-parcelas', 'data-primeira-parcela'];
    formInputs.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.addEventListener('input', previewInstallments);
    });
}

function toggleFormFields() {
    const tipo = document.getElementById('tipo-venda').value;
    const parceladoFields = document.getElementById('parcelado-fields');
    if (tipo === 'parcelada') {
        parceladoFields.style.display = 'block';
    } else {
        parceladoFields.style.display = 'none';
        document.getElementById('preview-parcelas').innerHTML = '';
    }
}

function previewInstallments() {
    const tipo = document.getElementById('tipo-venda').value;
    if (tipo !== 'parcelada') return;
    
    const valorTotal = parseFloat(document.getElementById('valor-total').value) || 0;
    const entrada = parseFloat(document.getElementById('entrada').value) || 0;
    const numParcelas = parseInt(document.getElementById('num-parcelas').value) || 0;
    const primeiraData = document.getElementById('data-primeira-parcela').value;
    
    if (!primeiraData || numParcelas <= 0 || valorTotal <= entrada) {
        document.getElementById('preview-parcelas').innerHTML = '';
        return;
    }
    
    const parcelas = calculateInstallments(valorTotal, entrada, numParcelas, primeiraData);
    let html = `<h4 style="margin-top:0; color:var(--text-secondary)">Preview das Parcelas</h4>`;
    html += `<ul style="list-style:none; padding:0; display:flex; flex-direction:column; gap:8px;">`;
    
    parcelas.forEach(p => {
        html += `<li style="display:flex; justify-content:space-between; padding:8px 12px; background:var(--bg-card); border-radius:8px; font-size:0.9rem;">
            <span>Parcela ${p.numero}</span>
            <span>R$ ${p.valor.toFixed(2)} - Vence em: ${formatDateBR(p.vencimento)}</span>
        </li>`;
    });
    html += `</ul>`;
    
    document.getElementById('preview-parcelas').innerHTML = html;
}

function formatDateBR(isoStr) {
    if (!isoStr) return '';
    const [y, m, d] = isoStr.split('-');
    return `${d}/${m}/${y}`;
}

function formatMoney(value) {
    return `R$ ${value.toFixed(2).replace('.', ',')}`;
}

async function saveVenda() {
    const cliente = document.getElementById('cliente').value.trim();
    const produto = document.getElementById('produto').value.trim();
    const valorTotal = parseFloat(document.getElementById('valor-total').value) || 0;
    const dataVenda = document.getElementById('data-venda').value;
    const tipo = document.getElementById('tipo-venda').value;
    
    if (!cliente || !produto || !valorTotal || !dataVenda) {
        alert("Preencha os campos obrigatórios (Cliente, Produto, Valor Total e Data da Venda).");
        return;
    }
    
    let entrada = 0;
    let parcelas = [];
    
    if (tipo === 'parcelada') {
        entrada = parseFloat(document.getElementById('entrada').value) || 0;
        const numParcelas = parseInt(document.getElementById('num-parcelas').value) || 0;
        const primeiraData = document.getElementById('data-primeira-parcela').value;
        
        if (numParcelas <= 0 || !primeiraData) {
            alert("Preencha o número de parcelas e a data da 1ª parcela.");
            return;
        }
        
        const newParcelas = calculateInstallments(valorTotal, entrada, numParcelas, primeiraData);
        
        if (currentEditId) {
            const existingVenda = vendas.find(v => v.id === currentEditId);
            if (existingVenda) {
                const existingParcelas = existingVenda.parcelas || [];
                parcelas = newParcelas.map((nP, i) => {
                    const eP = existingParcelas[i];
                    if (eP && eP.valor === nP.valor && eP.vencimento === nP.vencimento) {
                        return { ...nP, pago: eP.pago, dataPagamento: eP.dataPagamento };
                    }
                    return nP;
                });
            } else {
                parcelas = newParcelas;
            }
        } else {
            parcelas = newParcelas;
        }
    } else {
        entrada = valorTotal;
    }
    
    if (!auth.currentUser) {
        alert("Você precisa estar logado para salvar.");
        return;
    }

    const vendaObj = {
        userId: auth.currentUser.uid,
        tipo: 'venda_parcelada',
        cliente,
        produto,
        desc: produto, 
        valor: valorTotal,
        valorTotal,
        entrada,
        dataVenda,
        data: dataVenda, 
        parcelas
    };
    
    try {
        if (currentEditId) {
            await updateDoc(doc(db, "vendas", currentEditId), vendaObj);
        } else {
            await addDoc(collection(db, "vendas"), vendaObj);
        }
        resetForm();
    } catch (e) {
        console.error("Erro ao salvar: ", e);
        alert("Erro ao salvar venda: " + e.message);
    }
}

function resetForm() {
    currentEditId = null;
    document.getElementById('cliente').value = '';
    document.getElementById('produto').value = '';
    document.getElementById('valor-total').value = '';
    document.getElementById('data-venda').value = new Date().toISOString().substring(0, 10);
    document.getElementById('tipo-venda').value = 'parcelada';
    document.getElementById('entrada').value = '';
    document.getElementById('num-parcelas').value = '';
    document.getElementById('data-primeira-parcela').value = '';
    document.getElementById('preview-parcelas').innerHTML = '';
    
    document.getElementById('btn-save').innerText = 'Salvar Nova Venda';
    document.getElementById('btn-cancel').style.display = 'none';
    toggleFormFields();
}

window.editVenda = function(id) {
    const v = vendas.find(x => x.id === id);
    if (!v) return;
    
    currentEditId = id;
    document.getElementById('cliente').value = v.cliente;
    document.getElementById('produto').value = v.produto;
    document.getElementById('valor-total').value = v.valorTotal;
    document.getElementById('data-venda').value = v.dataVenda;
    
    if (v.parcelas && v.parcelas.length > 0) {
        document.getElementById('tipo-venda').value = 'parcelada';
        document.getElementById('entrada').value = v.entrada;
        document.getElementById('num-parcelas').value = v.parcelas.length;
        document.getElementById('data-primeira-parcela').value = v.parcelas[0].vencimento;
    } else {
        document.getElementById('tipo-venda').value = 'a_vista';
    }
    
    toggleFormFields();
    previewInstallments();
    
    document.getElementById('btn-save').innerText = 'Atualizar Venda';
    document.getElementById('btn-cancel').style.display = 'inline-block';
    
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.deleteVenda = async function(id) {
    if (!auth.currentUser) return;
    if (confirm("Tem certeza que deseja excluir esta venda?")) {
        try {
            await deleteDoc(doc(db, "vendas", id));
        } catch(e) {
            alert("Erro ao excluir: " + e.message);
        }
    }
}

window.togglePagamento = async function(vendaId, numeroParcela) {
    const v = vendas.find(x => x.id === vendaId);
    if (!v) return;
    
    const p = v.parcelas.find(x => x.numero === numeroParcela);
    if (!p) return;
    
    if (p.pago) {
        p.pago = false;
        p.dataPagamento = null;
    } else {
        const today = new Date().toISOString().substring(0, 10);
        const dataPagamentoStr = prompt("Data real de pagamento (AAAA-MM-DD):", today);
        if (dataPagamentoStr === null) return;
        p.pago = true;
        p.dataPagamento = dataPagamentoStr;
    }
    
    try {
        await updateDoc(doc(db, "vendas", vendaId), { parcelas: v.parcelas });
    } catch(e) {
        alert("Erro ao atualizar pagamento: " + e.message);
    }
}

function renderAll() {
    renderDashboard();
    renderAtrasadas();
    renderCobrancasMes();
    renderListagemVendas();
}

function renderDashboard() {
    let aReceber = 0;
    let jaRecebido = 0;
    let atrasado = 0;
    
    const todayStr = new Date().toISOString().substring(0, 10);
    
    vendas.forEach(v => {
        if (!v.parcelas || v.parcelas.length === 0) {
            const saleMonth = v.dataVenda.substring(0, 7);
            if (saleMonth === currentMonth) {
                jaRecebido += v.valorTotal;
            }
        } else {
            const saleMonth = v.dataVenda.substring(0, 7);
            if (v.entrada > 0 && saleMonth === currentMonth) {
                jaRecebido += v.entrada;
            }
            
            v.parcelas.forEach(p => {
                const isLate = !p.pago && p.vencimento < todayStr;
                if (isLate) {
                    atrasado += p.valor;
                }
                
                const dueMonth = p.vencimento.substring(0, 7);
                if (dueMonth === currentMonth && !p.pago) {
                    aReceber += p.valor;
                }
                
                if (p.pago && p.dataPagamento) {
                    const payMonth = p.dataPagamento.substring(0, 7);
                    if (payMonth === currentMonth) {
                        jaRecebido += p.valor;
                    }
                }
            });
        }
    });
    
    const totalPrevisto = jaRecebido + aReceber;
    
    document.getElementById('dash-a-receber').innerText = formatMoney(aReceber);
    document.getElementById('dash-recebido').innerText = formatMoney(jaRecebido);
    document.getElementById('dash-atrasado').innerText = formatMoney(atrasado);
    document.getElementById('dash-total-previsto').innerText = formatMoney(totalPrevisto);
}

function renderAtrasadas() {
    const todayStr = new Date().toISOString().substring(0, 10);
    let list = [];
    
    vendas.forEach(v => {
        if (!v.parcelas) return;
        v.parcelas.forEach(p => {
            if (!p.pago && p.vencimento < todayStr) {
                const diffTime = Math.abs(new Date(todayStr) - new Date(p.vencimento));
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
                list.push({ vendaId: v.id, cliente: v.cliente, parcela: p, atraso: diffDays });
            }
        });
    });
    
    list.sort((a, b) => b.atraso - a.atraso);
    
    const el = document.getElementById('list-atrasadas');
    if (list.length === 0) {
        el.innerHTML = `<div style="padding:16px; text-align:center; color:var(--text-secondary)">Sem atrasos!</div>`;
        return;
    }
    
    let html = `<div style="display:flex; flex-direction:column; gap:12px;">`;
    list.forEach(item => {
        html += `<div style="background:var(--bg-input); padding:16px; border-radius:12px; display:flex; justify-content:space-between; align-items:center; border-left:4px solid var(--danger);">
            <div>
                <div style="font-weight:600">${item.cliente}</div>
                <div style="font-size:0.85rem; color:var(--text-secondary)">Parcela ${item.parcela.numero} - Venceu ${formatDateBR(item.parcela.vencimento)} (${item.atraso} dias)</div>
                <div style="color:var(--danger); font-weight:700; margin-top:4px;">${formatMoney(item.parcela.valor)}</div>
            </div>
            <button class="btn-primary" style="padding:8px 16px; border-radius:8px; font-size:0.85rem; cursor:pointer;" onclick="togglePagamento('${item.vendaId}', ${item.parcela.numero})">Marcar Pago</button>
        </div>`;
    });
    html += `</div>`;
    el.innerHTML = html;
}

function renderCobrancasMes() {
    let list = [];
    
    vendas.forEach(v => {
        if (!v.parcelas) return;
        v.parcelas.forEach(p => {
            const dueMonth = p.vencimento.substring(0, 7);
            if (dueMonth === currentMonth && !p.pago) {
                list.push({ vendaId: v.id, cliente: v.cliente, parcela: p });
            }
        });
    });
    
    list.sort((a, b) => a.parcela.vencimento.localeCompare(b.parcela.vencimento));
    
    const el = document.getElementById('list-cobrancas-mes');
    if (list.length === 0) {
        el.innerHTML = `<div style="padding:16px; text-align:center; color:var(--text-secondary)">Nenhuma cobrança pendente este mês.</div>`;
        return;
    }
    
    let html = `<div style="display:flex; flex-direction:column; gap:12px;">`;
    list.forEach(item => {
        html += `<div style="background:var(--bg-input); padding:16px; border-radius:12px; display:flex; justify-content:space-between; align-items:center; border-left:4px solid var(--warning);">
            <div>
                <div style="font-weight:600">${item.cliente}</div>
                <div style="font-size:0.85rem; color:var(--text-secondary)">Parcela ${item.parcela.numero} - Vence em ${formatDateBR(item.parcela.vencimento)}</div>
                <div style="color:var(--warning); font-weight:700; margin-top:4px;">${formatMoney(item.parcela.valor)}</div>
            </div>
            <button class="btn-primary" style="padding:8px 16px; border-radius:8px; font-size:0.85rem; cursor:pointer;" onclick="togglePagamento('${item.vendaId}', ${item.parcela.numero})">Marcar Pago</button>
        </div>`;
    });
    html += `</div>`;
    el.innerHTML = html;
}

window.toggleExpandVenda = function(id) {
    const el = document.getElementById('venda-details-' + id);
    if (el) {
        el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
}

function renderListagemVendas() {
    const el = document.getElementById('list-todas-vendas');
    if (vendas.length === 0) {
        el.innerHTML = `<div style="padding:24px; text-align:center; color:var(--text-secondary)">Nenhuma venda cadastrada.</div>`;
        return;
    }
    
    let html = `<div style="display:flex; flex-direction:column; gap:16px;">`;
    vendas.forEach(v => {
        let status = '';
        let statusColor = '';
        
        if (!v.parcelas || v.parcelas.length === 0) {
            status = 'Quitada (À vista)';
            statusColor = 'var(--success)';
        } else {
            const numPagas = v.parcelas.filter(p => p.pago).length;
            if (numPagas === v.parcelas.length) {
                status = 'Quitada';
                statusColor = 'var(--success)';
            } else if (numPagas === 0) {
                status = 'Pendente';
                statusColor = 'var(--danger)';
            } else {
                status = 'Em Andamento';
                statusColor = 'var(--warning)';
            }
        }
        
        html += `
        <div class="glass" style="padding:20px; border-radius:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="toggleExpandVenda('${v.id}')">
                <div>
                    <div style="font-weight:700; font-size:1.1rem">${v.cliente}</div>
                    <div style="font-size:0.9rem; color:var(--text-secondary)">${v.produto} - ${formatDateBR(v.dataVenda)}</div>
                    <div style="margin-top:6px; display:inline-block; padding:4px 8px; border-radius:4px; font-size:0.75rem; font-weight:700; background:rgba(255,255,255,0.05); color:${statusColor}">${status}</div>
                </div>
                <div style="text-align:right">
                    <div style="font-weight:800; font-size:1.2rem">${formatMoney(v.valorTotal)}</div>
                    <div style="font-size:0.85rem; color:var(--text-secondary)">Entrada: ${formatMoney(v.entrada)}</div>
                </div>
            </div>
            
            <div id="venda-details-${v.id}" style="display:none; margin-top:20px; padding-top:20px; border-top:1px solid rgba(255,255,255,0.05)">
                <div style="display:flex; justify-content:flex-end; gap:8px; margin-bottom:16px;">
                    <button onclick="editVenda('${v.id}')" style="background:var(--accent-glow); border:none; color:white; padding:6px 12px; border-radius:6px; cursor:pointer;">Editar</button>
                    <button onclick="deleteVenda('${v.id}')" style="background:var(--danger); border:none; color:white; padding:6px 12px; border-radius:6px; cursor:pointer;">Excluir</button>
                </div>
                
                ${v.parcelas && v.parcelas.length > 0 ? `
                <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); gap:12px;">
                    ${v.parcelas.map(p => `
                        <div style="background:var(--bg-input); padding:12px; border-radius:8px; display:flex; justify-content:space-between; align-items:center; border-left:4px solid ${p.pago ? 'var(--success)' : 'var(--danger)'}">
                            <div>
                                <div style="font-size:0.8rem; color:var(--text-secondary)">Parcela ${p.numero}</div>
                                <div style="font-weight:700">${formatMoney(p.valor)}</div>
                                <div style="font-size:0.75rem; color:var(--text-secondary)">${p.pago ? `Pago em ${formatDateBR(p.dataPagamento)}` : `Vence ${formatDateBR(p.vencimento)}`}</div>
                            </div>
                            <button onclick="togglePagamento('${v.id}', ${p.numero})" style="background:${p.pago ? 'rgba(255,255,255,0.1)' : 'var(--accent-primary)'}; color:white; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:0.75rem;">
                                ${p.pago ? 'Desfazer' : 'Pagar'}
                            </button>
                        </div>
                    `).join('')}
                </div>
                ` : '<div style="color:var(--text-secondary); font-size:0.9rem">Venda à vista, sem parcelas.</div>'}
            </div>
        </div>`;
    });
    html += `</div>`;
    el.innerHTML = html;
}
