require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

// ==================== CONFIG ====================
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:1b';
const BOMBONIERE_API_URL = process.env.BOMBONIERE_API_URL || 'http://localhost:3000';

const WHATSAPP_CONTACT_RAW = (process.env.WHATSAPP_CONTACT || '').trim();
const ALLOWED_GROUP_ID = (process.env.ALLOWED_GROUP_ID || '').trim() || null;

function normalizarContatoWhatsApp(valor) {
  if (!valor) return null;

  const limpo = valor.trim();

  if (limpo.endsWith('@c.us') || limpo.endsWith('@g.us')) {
    return limpo;
  }

  const apenasNumeros = limpo.replace(/\D/g, '');
  if (!apenasNumeros) return null;

  return `${apenasNumeros}@c.us`;
}

const WHATSAPP_CONTACT = normalizarContatoWhatsApp(WHATSAPP_CONTACT_RAW);

// Estado por chat
const sessions = {};

// ==================== CLIENTE WHATSAPP ====================
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'estoque-bot',
    dataPath: './session',
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

async function safeSend(chatId, text) {
  try {
    await client.sendMessage(chatId, text);
  } catch (error) {
    console.error(`Erro ao enviar mensagem para ${chatId}:`, error.message);
  }
}

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('\n📱 Escaneie o QR Code acima com o WhatsApp');
});

client.on('ready', async () => {
  console.log('✅ Bot WhatsApp conectado!');
  console.log(`🤖 Modelo IA: ${OLLAMA_MODEL}`);
  console.log(`🎯 API Bomboniere: ${BOMBONIERE_API_URL}`);
  console.log(`👤 Contato privado liberado: ${WHATSAPP_CONTACT || 'nenhum'}`);
  console.log(`👥 Grupo liberado: ${ALLOWED_GROUP_ID || 'nenhum'}`);

  try {
    const chats = await client.getChats();
    const grupos = chats.filter((chat) => chat.isGroup);

    console.log('\n📋 Grupos encontrados:');
    grupos.forEach((grupo) => {
      console.log(`- Nome: ${grupo.name} | ID: ${grupo.id._serialized}`);
    });
  } catch (error) {
    console.error('Erro ao listar grupos:', error.message);
  }
});

client.on('authenticated', () => {
  console.log('🔐 Sessão autenticada com sucesso.');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Falha de autenticação:', msg);
});

client.on('disconnected', (reason) => {
  console.warn('⚠️ Bot desconectado:', reason);
});

// ==================== OLLAMA ====================
async function perguntarIA(systemPrompt, userMessage) {
  try {
    const response = await axios.post(`${OLLAMA_URL}/api/chat`, {
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    return response.data?.message?.content || null;
  } catch (error) {
    const status = error.response?.status;
    const body = error.response?.data;
    console.error('Erro ao chamar Ollama:', status || '', body || error.message);
    return null;
  }
}

const SYSTEM_PROMPT_PRODUTO = `
Você é um assistente especializado em extrair dados para cadastro de produtos de uma bomboniere.

Sua tarefa é ler a mensagem do usuário e responder APENAS com um JSON válido.

Formato esperado:
{
  "nome": "string",
  "descricao": "string ou null",
  "preco": "number",
  "custoUnit": "number",
  "estoqueMin": "number",
  "categoria": "string",
  "unidade": "string",
  "quantidadeInicial": "number",
  "lote": "string ou null",
  "localizacao": "string ou null",
  "dataValidade": "string ISO ou null",
  "imagens": [],
  "variacoes": [
    {
      "sabor": "string",
      "preco": "number ou null",
      "quantidadeInicial": "number",
      "lote": "string ou null",
      "localizacao": "string ou null",
      "dataValidade": "string ISO ou null",
      "imagens": []
    }
  ]
}

Regras:
- Responda apenas JSON puro.
- Não use markdown.
- Não use crases.
- Categorias permitidas: chocolates, balas, salgadinhos, bebidas, doces, outros.
- Unidade padrão: "un".
- Estoque mínimo padrão: 5.
- Custo unitário padrão: 0.
- Imagens sempre devem ser [] se não houver dados.
- Se houver sabores/variações, preencha "variacoes" e deixe "quantidadeInicial" do produto principal como 0.
- Se não houver variações, "variacoes" deve ser [].
- Se faltar um campo obrigatório, use null.
`.trim();

// ==================== HELPERS ====================
function formatarDinheiro(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return '0,00';
  return numero.toFixed(2).replace('.', ',');
}

function extrairJsonSeguro(resposta) {
  if (!resposta || typeof resposta !== 'string') {
    throw new Error('Resposta vazia do modelo');
  }

  const texto = resposta
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    return JSON.parse(texto);
  } catch (_) {}

  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('Não foi possível extrair JSON da resposta do modelo');
  }

  return JSON.parse(match[0]);
}

function normalizarProdutoIA(dados) {
  const categoriasPermitidas = [
    'chocolates',
    'balas',
    'salgadinhos',
    'bebidas',
    'doces',
    'outros',
  ];

  const produto = {
    nome: String(dados?.nome || '').trim(),
    descricao: dados?.descricao ? String(dados.descricao).trim() : null,
    preco: Number(dados?.preco ?? 0),
    custoUnit: Number(dados?.custoUnit ?? 0),
    estoqueMin: Number.isFinite(Number(dados?.estoqueMin))
      ? parseInt(dados.estoqueMin, 10)
      : 5,
    categoria: categoriasPermitidas.includes(
      String(dados?.categoria || '').trim().toLowerCase()
    )
      ? String(dados.categoria).trim().toLowerCase()
      : null,
    unidade: String(dados?.unidade || 'un').trim() || 'un',
    quantidadeInicial: Number.isFinite(Number(dados?.quantidadeInicial))
      ? parseInt(dados.quantidadeInicial, 10)
      : 0,
    lote: dados?.lote ? String(dados.lote).trim() : null,
    localizacao: dados?.localizacao ? String(dados.localizacao).trim() : null,
    dataValidade: dados?.dataValidade ? String(dados.dataValidade).trim() : null,
    imagens: Array.isArray(dados?.imagens) ? dados.imagens : [],
    variacoes: Array.isArray(dados?.variacoes)
      ? dados.variacoes
          .map((v) => ({
            sabor: String(v?.sabor || '').trim(),
            preco:
              v?.preco === null || v?.preco === undefined || v?.preco === ''
                ? null
                : Number(v.preco),
            quantidadeInicial: Number.isFinite(Number(v?.quantidadeInicial))
              ? parseInt(v.quantidadeInicial, 10)
              : 0,
            lote: v?.lote ? String(v.lote).trim() : null,
            localizacao: v?.localizacao ? String(v.localizacao).trim() : null,
            dataValidade: v?.dataValidade ? String(v.dataValidade).trim() : null,
            imagens: Array.isArray(v?.imagens) ? v.imagens : [],
          }))
          .filter((v) => v.sabor)
      : [],
  };

  return produto;
}

function validarProdutoParaBackend(produto) {
  if (!produto.nome) {
    return { ok: false, erro: 'Nome do produto é obrigatório.' };
  }

  if (!produto.categoria) {
    return { ok: false, erro: 'Categoria inválida. Use chocolates, balas, salgadinhos, bebidas, doces ou outros.' };
  }

  if (!Number.isFinite(produto.preco) || produto.preco < 0) {
    return { ok: false, erro: 'Preço inválido.' };
  }

  if (!Number.isFinite(produto.custoUnit) || produto.custoUnit < 0) {
    return { ok: false, erro: 'Custo unitário inválido.' };
  }

  if (!Number.isInteger(produto.estoqueMin) || produto.estoqueMin < 0) {
    return { ok: false, erro: 'Estoque mínimo inválido.' };
  }

  if (!produto.unidade) {
    return { ok: false, erro: 'Unidade inválida.' };
  }

  if (produto.variacoes.length > 0) {
    for (const variacao of produto.variacoes) {
      if (!variacao.sabor) {
        return { ok: false, erro: 'Toda variação precisa ter sabor.' };
      }

      if (!Number.isInteger(variacao.quantidadeInicial) || variacao.quantidadeInicial < 0) {
        return {
          ok: false,
          erro: `Quantidade inválida na variação ${variacao.sabor}.`,
        };
      }

      if (variacao.preco !== null && (!Number.isFinite(variacao.preco) || variacao.preco < 0)) {
        return {
          ok: false,
          erro: `Preço inválido na variação ${variacao.sabor}.`,
        };
      }
    }
  } else {
    if (!Number.isInteger(produto.quantidadeInicial) || produto.quantidadeInicial < 0) {
      return { ok: false, erro: 'Quantidade inicial inválida.' };
    }
  }

  return { ok: true };
}

function montarPayloadBackend(produto) {
  return {
    nome: produto.nome,
    descricao: produto.descricao,
    preco: produto.preco,
    custoUnit: produto.custoUnit,
    estoqueMin: produto.estoqueMin,
    categoria: produto.categoria,
    unidade: produto.unidade,
    quantidadeInicial: produto.variacoes.length > 0 ? 0 : produto.quantidadeInicial,
    lote: produto.variacoes.length > 0 ? null : produto.lote,
    localizacao: produto.variacoes.length > 0 ? null : produto.localizacao,
    dataValidade: produto.variacoes.length > 0 ? null : produto.dataValidade,
    imagens: produto.imagens,
    variacoes: produto.variacoes,
  };
}

function formatarConfirmacao(produto) {
  let msg = `*📦 Confirmação de cadastro*\n\n`;
  msg += `*Nome:* ${produto.nome}\n`;
  msg += `*Preço:* R$ ${formatarDinheiro(produto.preco)}\n`;
  msg += `*Custo Unit:* R$ ${formatarDinheiro(produto.custoUnit)}\n`;
  msg += `*Categoria:* ${produto.categoria}\n`;
  msg += `*Unidade:* ${produto.unidade}\n`;
  msg += `*Estoque mín:* ${produto.estoqueMin}\n`;

  if (produto.descricao) msg += `*Descrição:* ${produto.descricao}\n`;

  if (produto.variacoes.length > 0) {
    msg += `\n*Variações:*\n`;
    produto.variacoes.forEach((v, i) => {
      msg += `${i + 1}. ${v.sabor} | qtd ${v.quantidadeInicial}`;
      if (v.preco !== null) msg += ` | R$ ${formatarDinheiro(v.preco)}`;
      if (v.lote) msg += ` | lote ${v.lote}`;
      if (v.localizacao) msg += ` | loc ${v.localizacao}`;
      msg += `\n`;
    });
  } else {
    msg += `*Qtd Inicial:* ${produto.quantidadeInicial} ${produto.unidade}\n`;
    if (produto.lote) msg += `*Lote:* ${produto.lote}\n`;
    if (produto.localizacao) msg += `*Localização:* ${produto.localizacao}\n`;
    if (produto.dataValidade) msg += `*Validade:* ${produto.dataValidade}\n`;
  }

  msg += `\nResponda:\n`;
  msg += `✅ *sim* para confirmar\n`;
  msg += `❌ *nao* para cancelar\n`;
  msg += `✏️ *edit* para enviar tudo de novo`;

  return msg;
}

// ==================== API ====================
async function criarProdutoNoBomboniere(produto, remetente) {
  try {
    const payload = {
      ...montarPayloadBackend(produto),
      remetente,
    };

    const response = await axios.post(
      `${BOMBONIERE_API_URL}/api/produtos`,
      payload,
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );

    return { success: true, data: response.data };
  } catch (error) {
    const status = error.response?.status;
    const message =
      error.response?.data?.error ||
      error.response?.data?.message ||
      error.message;

    return { success: false, error: `HTTP ${status || 500}: ${message}` };
  }
}

// ==================== FLUXO ====================
async function processarMensagem(msg, chatId) {
  const textoOriginal = (msg.body || '').trim();
  const texto = textoOriginal.toLowerCase();

  if (!texto) return;

  if (texto === '/status') {
    await safeSend(
      chatId,
      `✅ Bot online\n🤖 Modelo: ${OLLAMA_MODEL}\n🎯 API: ${BOMBONIERE_API_URL}\n👥 Grupo teste: ${ALLOWED_GROUP_ID || 'não configurado'}`
    );
    return;
  }

  if (texto === '/cancelar') {
    if (sessions[chatId]) {
      delete sessions[chatId];
      await safeSend(chatId, '❌ Operação cancelada.');
    } else {
      await safeSend(chatId, 'ℹ️ Não há operação pendente.');
    }
    return;
  }

  if (!sessions[chatId]) {
    const resposta = await perguntarIA(
      SYSTEM_PROMPT_PRODUTO,
      textoOriginal
    );

    if (!resposta) {
      await safeSend(
        chatId,
        '❌ Erro ao processar com o modelo local. Verifique se o Ollama está rodando e se o modelo foi instalado.'
      );
      return;
    }

    let bruto;
    try {
      bruto = extrairJsonSeguro(resposta);
    } catch (e) {
      await safeSend(
        chatId,
        '❓ Não consegui entender.\n\nEnvie algo como:\n"Redbull, preço 12.50, categoria bebidas, quantidade 24"\n\nOu com variações:\n"Trident sabores morango e menta, preço 3.50, categoria doces, 10 de cada"'
      );
      return;
    }

    const produto = normalizarProdutoIA(bruto);
    const validacao = validarProdutoParaBackend(produto);

    if (!validacao.ok) {
      await safeSend(chatId, `❓ ${validacao.erro}`);
      return;
    }

    sessions[chatId] = {
      step: 'confirmar',
      data: produto,
    };

    await safeSend(chatId, formatarConfirmacao(produto));
    return;
  }

  const session = sessions[chatId];

  if (session.step === 'confirmar') {
    if (texto === 'sim' || texto === 's') {
      session.step = 'enviando';

      await safeSend(chatId, '⏳ Enviando para o sistema...');

      const result = await criarProdutoNoBomboniere(session.data, chatId);

      if (result.success) {
        const retorno = result.data || {};
        await safeSend(
          chatId,
          `✅ Produto cadastrado com sucesso!\n\n` +
            `ID: ${retorno.id || retorno.produto?.id || '—'}\n` +
            `Nome: ${session.data.nome}\n` +
            `Preço: R$ ${formatarDinheiro(session.data.preco)}\n` +
            `Variações: ${session.data.variacoes.length}`
        );
      } else {
        await safeSend(
          chatId,
          `❌ Erro ao cadastrar produto:\n${result.error}`
        );
      }

      delete sessions[chatId];
      return;
    }

    if (texto === 'nao' || texto === 'não' || texto === 'n') {
      delete sessions[chatId];
      await safeSend(chatId, '❌ Cadastro cancelado.');
      return;
    }

    if (texto === 'edit' || texto.startsWith('edit ')) {
      delete sessions[chatId];
      await safeSend(
        chatId,
        '✏️ Envie a descrição corrigida do produto como uma nova mensagem.'
      );
      return;
    }

    await safeSend(
      chatId,
      '❓ Responda *sim*, *nao* ou *edit*.\n\n' + formatarConfirmacao(session.data)
    );
  }
}

// ==================== FILTRO ====================
client.on('message', async (msg) => {
  if (msg.fromMe) return;

  const chatId = msg.from || '';
  const texto = (msg.body || '').trim();

  if (!texto) return;

  if (chatId.endsWith('@newsletter')) return;
  if (chatId.endsWith('@status')) return;

  if (ALLOWED_GROUP_ID) {
    if (chatId !== ALLOWED_GROUP_ID) return;
  } else {
    if (chatId.endsWith('@g.us')) return;
    if (WHATSAPP_CONTACT && chatId !== WHATSAPP_CONTACT) return;
  }

  console.log(`📩 Mensagem recebida de ${chatId}: ${texto}`);

  try {
    await processarMensagem(msg, chatId);
  } catch (error) {
    console.error('Erro ao processar mensagem:', error.message);
    await safeSend(chatId, `❌ Erro interno: ${error.message}`);
  }
});

// ==================== START ====================
console.log('🚀 Iniciando bot WhatsApp + LLM...');
client.initialize();