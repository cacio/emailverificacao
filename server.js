import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import QRCode from "qrcode";

// 🔧 CONFIGURAÇÃO DO PIX
const chavePix = "92113026000164";
const nome = "Prodasiq Sistemas";
const cidade = "PORTO ALEGRE";

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Função CRC16
function crc16(payload) {
  let crc = 0xffff;

  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;

    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else crc <<= 1;

      crc &= 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, "0");
}

// Monta o payload PIX
function gerarPayloadPix(chave, nome, cidade, valor, descricao = "") {
  valor = Number(valor).toFixed(2);

  descricao = descricao
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 \-_.]/g, "")
    .slice(0, 50);

  const gui = "br.gov.bcb.pix";

  let campo26 =
    "00" + gui.length.toString().padStart(2, "0") + gui +
    "01" + chave.length.toString().padStart(2, "0") + chave;

  if (descricao) {
    campo26 += "02" + descricao.length.toString().padStart(2, "0") + descricao;
  }

  campo26 = "26" + campo26.length.toString().padStart(2, "0") + campo26;

  const payload =
    "000201" +
    "010212" +
    campo26 +
    "52040000" +
    "5303986" +
    "54" + valor.length.toString().padStart(2, "0") + valor +
    "5802BR" +
    "59" + nome.length.toString().padStart(2, "0") + nome +
    "60" + cidade.length.toString().padStart(2, "0") + cidade +
    "62070503***" +
    "6304";

  return payload + crc16(payload);
}

// Mapa de códigos
const codigosAtivos = new Map();

// =============================
// PIX À VISTA
// =============================
app.post("/pix/avista", express.json(), async (req, res) => {
  const { valorAvista, obs } = req.body;

  if (!valorAvista) {
    return res.status(400).json({ error: "Informe valorAvista" });
  }

  const payload = gerarPayloadPix(
    chavePix,
    nome,
    cidade,
    valorAvista,
    `Pagamento à vista ${obs}`
  );

  const qrBase64 = await QRCode.toDataURL(payload);

  res.json({
    tipo: "avista",
    valor: valorAvista,
    payload,
    qrcode: qrBase64
  });
});

// =============================
// PIX A PRAZO (1 + 3)
// =============================
app.post("/pix/aprazo", express.json(), async (req, res) => {
  const { valorTotal, obs } = req.body;

  if (!valorTotal) {
    return res.status(400).json({ error: "Informe valorTotal" });
  }

  // 1 + 3 → entrada = 25% do total
  const valorEntrada = Number(valorTotal) / 4;

  const payload = gerarPayloadPix(
    chavePix,
    nome,
    cidade,
    valorEntrada,
    `Entrada (1+3) ${obs}`
  );

  const qrBase64 = await QRCode.toDataURL(payload);

  res.json({
    tipo: "aprazo",
    valorEntrada,
    valorTotal,
    payload,
    qrcode: qrBase64
  });
});

// =============================
// ENVIAR CÓDIGO
// =============================
app.post("/enviar-codigo", express.json(), async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "E-mail é obrigatório." });

  const codigo = Math.floor(100000 + Math.random() * 900000).toString();
  const expiraEm = Date.now() + 10 * 60 * 1000; // expira em 10 minutos
  codigosAtivos.set(email, { codigo, expiraEm });

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.prodasiq.com.br", // ou o SMTP da AWS / Gmail etc.
      port: 587,
      secure: false,
      auth: {
        user: "noreply@prodasiq.com.br",
        pass: "Pr0d@5Iq", // use variável de ambiente em produção
      },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from: '"Retaguarda 4.0" <noreply@prodasiq.com.br>',
      to: email,
      subject: "Código de Verificação",
      html: `
        <p>Olá!</p>
        <p>Seu código de verificação é:</p>
        <h2 style="font-size:22px;">${codigo}</h2>
        <p>Ele expira em 10 minutos.</p>
      `,
    });

    res.json({ ok: true, message: "Código enviado para o e-mail informado." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao enviar o e-mail de verificação." });
  }
});

// =============================
// VALIDAR CÓDIGO
// =============================
app.post("/validar-codigo", express.json(), (req, res) => {
  const { email, codigo } = req.body;
  const registro = codigosAtivos.get(email);

  if (!registro)
    return res.status(400).json({ error: "Nenhum código encontrado para esse e-mail." });

  if (Date.now() > registro.expiraEm)
    return res.status(400).json({ error: "Código expirado. Solicite um novo." });

  if (registro.codigo !== codigo)
    return res.status(400).json({ error: "Código incorreto." });

  codigosAtivos.delete(email);
  res.json({ ok: true, message: "E-mail verificado com sucesso!" });
});

// =============================
// ENVIAR CONFIRMAÇÃO
// =============================
app.post("/enviar-confirmacao", express.json(), async (req, res) => {
  const { email, tipopagamento, valortotal, obs } = req.body;
  if (!email) return res.status(400).json({ error: "E-mail é obrigatório." });

  if (!tipopagamento || !valortotal) {
    return res.status(400).json({ error: "Tipo de pagamento e valor total são obrigatórios." });
  }

  let qrBase64 = null;
  let valorpix = 0;
  let payload = null;
  if (tipopagamento === 'avista') {
    valorpix = valortotal;
    payload = gerarPayloadPix(
      chavePix,
      nome,
      cidade,
      valortotal,
      `Pagamento à vista ${obs}`
    );

    qrBase64 = await QRCode.toDataURL(payload);
  } else {
    // 1 + 3 → entrada = 25% do total
    const valorEntrada = Number(valortotal) / 4;
    valorpix = valorEntrada;
    payload = gerarPayloadPix(
      chavePix,
      nome,
      cidade,
      valorEntrada,
      `Entrada (1+3) ${obs}`
    );

    qrBase64 = await QRCode.toDataURL(payload);
  }

  const base64Data = qrBase64.replace(/^data:image\/png;base64,/, "");

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.prodasiq.com.br", // ou o SMTP da AWS / Gmail etc.
      port: 587,
      secure: false,
      auth: {
        user: "noreply@prodasiq.com.br",
        pass: "Pr0d@5Iq", // use variável de ambiente em produção
      },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from: '"Retaguarda 4.0" <noreply@prodasiq.com.br>',
      to: email,
      subject: "Solicitação de implantação - Retaguarda 4.0",
      html: `
        <div style="width:100%;background:#f5f7fb;padding:40px 0;font-family:Arial, sans-serif;">
          <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;padding:35px;box-shadow:0 5px 20px rgba(0,0,0,0.08);">

            <div style="text-align:center;margin-bottom:25px;">
              <img src="https://prodasiq.com.br/reformatributaria/assets/images/Image20251117164631.png" alt="Prodasiq" style="width:160px;">
            </div>

            <h2 style="color:#1a1a1a;text-align:center;font-size:22px;margin-bottom:10px;">
              Solicitação de implantação confirmada!
            </h2>

            <p style="color:#444;font-size:15px;line-height:1.6;text-align:center;">
              Recebemos sua solicitação para implantar o <strong>Retaguarda 4.0</strong>!
            </p>

            <div style="margin-top:30px;">

              <p style="color:#444;font-size:15px;line-height:1.6;">
                ℹ️ Lembramos que para darmos andamento no processo de implantação é necessário validar sua licença, através do envio do comprovante por um de nossos canais abaixo:
              </p>

              <ul style="color:#444;font-size:15px;line-height:1.6;margin-left:18px;">
                <li style="margin-bottom:10px;">
                  <strong>E-mail:</strong>
                  <a href="mailto:comprovante@prodasiq.com.br" style="color:#2a4eff;text-decoration:none;">
                    comprovante@prodasiq.com.br
                  </a>
                  <br><span style="font-size:13px;color:#777;">(resposta em até 2 horas úteis)</span>
                </li>

                <li>
                  <strong>WhatsApp:</strong>
                  <a href="https://wa.me/555191703182?text=Olá,%20estou%20enviando%20o%20comprovante%20de%20pagamento%20da%20implantação%20Retaguarda%204.0."
                    style="color:#2a4eff;text-decoration:none;font-weight:bold;">
                    Clique aqui para enviar diretamente para nossa equipe
                  </a>
                </li>
              </ul>
              <div>
                <h3>Finalize em minutos: Pagamento via PIX</h3>
                <p>Escaneie o QR Code ou copie a chave PIX abaixo para pagar o valor de ${formatarMoeda(valorpix)}.</p>
                <img src="cid:qrcodepix"
                  alt="QR Code PIX"
                  style="width:200px;margin:20px auto;display:block;" />
                  <p><strong>Ou copie o código PIX:</strong></p>
                  <div class="pix-code-box" id="pix-code" style="background:#f1f5f9;padding: 1rem; border-radius:0.5rem; margin: 1rem 0;word-break: break-all;font-family: monospace;font-size: 0.85rem;position: relative;">
                    ${payload}
                  </div>
              </div>
              <p style="color:#444;font-size:15px;line-height:1.6;margin-top:25px;">
               Caso já tenha enviado o comprovante, fique tranquilo! Após a confirmação nossa equipe entrará em contato para implantar o sistema e lhe passar todas informações necessárias.
              </p>
            </div>

            <div style="text-align:center;margin-top:35px;font-size:13px;color:#999;">
              © ${new Date().getFullYear()} Prodasiq Sistemas. Todos os direitos reservados.
            </div>

          </div>
        </div>
      `,
      attachments: [
        {
          filename: "qrcode.png",
          cid: "qrcodepix",      // mesmo nome usado no HTML
          content: Buffer.from(base64Data, "base64"),
          encoding: "base64"
        }
      ]
    });

    res.json({ ok: true, message: "E-mail enviado com sucesso.", "qrBase64": qrBase64 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao enviar o e-mail de confirmação." });
  }
});

app.post("/reenvia-comprovante", express.json(), async (req, res) => {
  const { email, tipopagamento, valortotal, obs } = req.body;
  if (!email) return res.status(400).json({ error: "E-mail é obrigatório." });

  if (!tipopagamento || !valortotal) {
    return res.status(400).json({ error: "Tipo de pagamento e valor total são obrigatórios." });
  }

  let qrBase64 = null;
  let valorpix = 0;
  let payload = null;
  if (tipopagamento === 'avista') {
    valorpix = valortotal;
    payload = gerarPayloadPix(
      chavePix,
      nome,
      cidade,
      valortotal,
      `Pagamento à vista ${obs}`
    );

    qrBase64 = await QRCode.toDataURL(payload);
  } else {
    // 1 + 3 → entrada = 25% do total
    const valorEntrada = Number(valortotal) / 4;
    valorpix = valorEntrada;
    payload = gerarPayloadPix(
      chavePix,
      nome,
      cidade,
      valorEntrada,
      `Entrada (1+3) ${obs}`
    );

    qrBase64 = await QRCode.toDataURL(payload);
  }

  const base64Data = qrBase64.replace(/^data:image\/png;base64,/, "");

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.prodasiq.com.br", // ou o SMTP da AWS / Gmail etc.
      port: 587,
      secure: false,
      auth: {
        user: "noreply@prodasiq.com.br",
        pass: "Pr0d@5Iq", // use variável de ambiente em produção
      },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from: '"Retaguarda 4.0" <noreply@prodasiq.com.br>',
      to: email,
      subject: "📌 LEMBRETE - Enviar comprovante para validar licença Retaguarda 4.0",
      html: `
        <div style="width:100%;background:#f5f7fb;padding:40px 0;font-family:Arial, sans-serif;">
          <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;padding:35px;box-shadow:0 5px 20px rgba(0,0,0,0.08);">

            <div style="text-align:center;margin-bottom:25px;">
              <img src="https://prodasiq.com.br/reformatributaria/assets/images/Image20251117164631.png" alt="Prodasiq" style="width:160px;">
            </div>

            <p style="color:#444;font-size:15px;line-height:1.6;text-align:center;">
             Prezado, cliente!<br>Sua solicitação para agendamento da implantação do Retaguarda 4.0 foi recebida com sucesso e encontra-se na seguinte situação:
            </p>

            <div style="margin-top:30px;">

            <p style="color:#444;font-size:15px;line-height:1.6;">
              ⏳ Status: Aguardando envio de comprovante
            </p>

            <p style="color:#444;font-size:15px;line-height:1.6;">
            Estamos passando para lembrar que o agendamento só será efetivado após a confirmação do recebimento do seu comprovante.
            Pedimos que nos encaminhe o comprovante através de um dos nossos canais abaixo:
              <ul style="color:#444;font-size:15px;line-height:1.6;margin-left:18px;">
                <li style="margin-bottom:10px;">
                  <strong>E-mail:</strong>
                  <a href="mailto:comprovante@prodasiq.com.br" style="color:#2a4eff;text-decoration:none;">
                    comprovante@prodasiq.com.br
                  </a>
                  <br><span style="font-size:13px;color:#777;">(resposta em até 2 horas úteis)</span>
                </li>

                <li>
                  <strong>WhatsApp:</strong>
                  <a href="https://wa.me/555191703182?text=Olá,%20estou%20enviando%20o%20comprovante%20de%20pagamento%20da%20implantação%20Retaguarda%204.0."
                    style="color:#2a4eff;text-decoration:none;font-weight:bold;">
                    Clique aqui para enviar diretamente para nossa equipe
                  </a>
                </li>
              </ul>
            </p>

            <p style="color:#444;font-size:15px;line-height:1.6;">
            ⚠️ <strong>IMPORTANTE:</strong> Esta etapa é necessária para validar sua nova licença e para que nossa equipe possa executar a implantação e treinamento do <strong>Retaguarda 4.0</strong>.
            </p>

            <p style="color:#444;font-size:15px;line-height:1.6;">
            🚨 <strong>AVISO:</strong> Caso o comprovante não seja enviado em até 48h após o recebimento deste lembrete, seu agendamento será suspenso e você precisará efetuar nova solicitação.
            </p>

            <p style="color:#444;font-size:15px;line-height:1.6;">
            Dúvidas entrar em contato! Estaremos à disposição!
            </p>

                  <div>
                    <h3>Caso não tenha efetuado o pagamento ainda segue abaixo o PIX, conforme selecionado no momento da sua solicitação:</h3>
                    <p>Escaneie o QR Code ou copie a chave PIX abaixo para pagar o valor de ${formatarMoeda(valorpix)}.</p>
                    <img src="cid:qrcodepix"
                      alt="QR Code PIX"
                      style="width:200px;margin:20px auto;display:block;" />
                      <p><strong>Ou copie o código PIX:</strong></p>
                      <div class="pix-code-box" id="pix-code" style="background:#f1f5f9;padding: 1rem; border-radius:0.5rem; margin: 1rem 0;word-break: break-all;font-family: monospace;font-size: 0.85rem;position: relative;">
                        ${payload}
                      </div>
                  </div>
                  <p style="color:#444;font-size:15px;line-height:1.6;margin-top:25px;">
                    ℹ️ <strong><i>Caso já tenha enviado o comprovante, desconsidere este aviso.<i></strong>
                  </p>
                </div>

                <div style="text-align:center;margin-top:35px;font-size:13px;color:#999;">
                  © ${new Date().getFullYear()} Prodasiq Sistemas. Todos os direitos reservados.
                </div>

              </div>
            </div>
          `,
      attachments: [
        {
          filename: "qrcode.png",
          cid: "qrcodepix",      // mesmo nome usado no HTML
          content: Buffer.from(base64Data, "base64"),
          encoding: "base64"
        }
      ]
    });

    res.json({ ok: true, message: "E-mail enviado com sucesso.", "qrBase64": qrBase64 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao enviar o e-mail de confirmação." });
  }
});

app.post("/cancelado", express.json(), async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "E-mail é obrigatório." });



  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.prodasiq.com.br", // ou o SMTP da AWS / Gmail etc.
      port: 587,
      secure: false,
      auth: {
        user: "noreply@prodasiq.com.br",
        pass: "Pr0d@5Iq", // use variável de ambiente em produção
      },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from: '"Retaguarda 4.0" <noreply@prodasiq.com.br>',
      to: email,
      subject: "🚨 *ATENÇÃO! - Sua solicitação para agendamento da implantação do Retaguarda 4.0 foi SUSPENSA*",
      html: `
        <div style="width:100%;background:#f5f7fb;padding:40px 0;font-family:Arial, sans-serif;">
          <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;padding:35px;box-shadow:0 5px 20px rgba(0,0,0,0.08);">

            <div style="text-align:center;margin-bottom:25px;">
              <img src="https://prodasiq.com.br/reformatributaria/assets/images/Image20251117164631.png" alt="Prodasiq" style="width:160px;">
            </div>

            <p style="color:#444;font-size:15px;line-height:1.6;text-align:center;">
            Prezado(a) Cliente,
            </p>

            <div style="margin-top:30px;">

              <p style="color:#444;font-size:15px;line-height:1.6;">
                Conforme o lembrete enviado anteriormente, o comprovante de pagamento referente à sua solicitação de implantação do Retaguarda 4.0 <strong>*não foi localizado*</strong>.
              <p>

              <p style="color:#444;font-size:15px;line-height:1.6;">
                Por este motivo, sua <strong>*solicitação de agendamento foi oficialmente suspensa*</strong>e sua vaga não pode ser reservada, liberando a prioridade para a próxima solicitação confirmada.
              </p>

              <p style="color:#444;font-size:15px;line-height:1.6;">
                Para reverter esta situação e reativar imediatamente o agendamento, finalize a confirmação enviando o comprovante para um de nossos canais abaixo:
                <ul style="color:#444;font-size:15px;line-height:1.6;margin-left:18px;">
                  <li style="margin-bottom:10px;">
                    <strong>E-mail:</strong>
                    <a href="mailto:comprovante@prodasiq.com.br" style="color:#2a4eff;text-decoration:none;">
                    comprovante@prodasiq.com.br
                    </a>
                    <br><span style="font-size:13px;color:#777;">(resposta em até 2 horas úteis)</span>
                  </li>

                  <li>
                    <strong>WhatsApp:</strong>
                    <a href="https://wa.me/555191703182?text=Olá,%20estou%20enviando%20o%20comprovante%20de%20pagamento%20da%20implantação%20Retaguarda%204.0."
                    style="color:#2a4eff;text-decoration:none;font-weight:bold;">
                    Clique aqui para enviar diretamente para nossa equipe
                    </a>
                  </li>
                </ul>
             </p>

             <p style="color:#444;font-size:15px;line-height:1.6;">
               Ou refaça a aquisição clicando no link: [https://prodasiq.com.br/reformatributaria/index.html]<br><br>
              ⚠️<strong>*ATENÇÃO: O prazo para a implantação encerra em 31/12/2025. Aconselhamos a ação imediata para evitar a paralisação do faturamento em 2026.*</strong>
            </p>


			 <p tyle="color:#444;font-size:15px;line-height:1.6;">
				À disposição,<br>
				PRODASIQ DESENVOLVIMENTO DE SISTEMAS
				(51) 999 544 057
			 </p>


            </div>

            <div style="text-align:center;margin-top:35px;font-size:13px;color:#999;">
              © ${new Date().getFullYear()} Prodasiq Sistemas. Todos os direitos reservados.
            </div>

          </div>
        </div>
      `,

    });

    res.json({ ok: true, message: "E-mail enviado com sucesso." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao enviar o e-mail de cancelamento." });
  }
});

app.post("/lembrete-agendamento", express.json(), async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "E-mail é obrigatório." });



  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.prodasiq.com.br", // ou o SMTP da AWS / Gmail etc.
      port: 587,
      secure: false,
      auth: {
        user: "noreply@prodasiq.com.br",
        pass: "Pr0d@5Iq", // use variável de ambiente em produção
      },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from: '"Retaguarda 4.0" <noreply@prodasiq.com.br>',
      to: email,
      subject: "⌛ [ACABANDO] Faltam 14 dias: Garanta sua virada de ano com o Retaguarda 4.0 implantado",
      html: `
        <div style="width:100%;background:#f5f7fb;padding:40px 0;font-family:Arial, sans-serif;">
          <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;padding:35px;box-shadow:0 5px 20px rgba(0,0,0,0.08);">

            <p>Prezado(a) Cliente,</p>

            <p>
              Faltam apenas <strong>14 dias</strong> para a entrada em vigor das novas diretrizes da <strong>Reforma Tributária (IBS/CBS)</strong>.
            </p>

            <p>
              ⚠️ Para garantir que sua empresa inicie 2026 emitindo notas fiscais com total segurança e atendendo as novas obrigatoriedades, precisamos realizar sua implantação do <strong>Retaguarda 4.0</strong>.
            </p>

            <p>
              🚨 Nossa agenda de implantação para este ano está atingindo o limite de vagas. Não deixe para a última hora, evite inconsistências fiscais e multas por atraso no registro.
            </p>

            <p>
              <img src="https://fonts.gstatic.com/s/e/notoemoji/16.0/1f517/32.png" alt="🔗" style="vertical-align:middle;width:16px;">
              &nbsp;<b>
                <a href="https://prodasiq.com.br/reformatributaria/index.html" target="_blank">
                  AGENDE AGORA MESMO SUA IMPLANTAÇÃO
                </a>
              </b>
            </p>

            <p>À disposição,</p>

            <div style="margin-bottom:20px;padding-bottom:6px;">
              <b>PRODASIQ DESENVOLVIMENTO DE SISTEMAS</b>
              <p> (51) 999 544 057<br></p>
            </div>
          </div>
        </div>
      `,

    });

    res.json({ ok: true, message: "E-mail enviado com sucesso." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao enviar o e-mail de cancelamento." });
  }
});

function formatarMoeda(valor) {
  return valor.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}
// =============================
// Porta do Render
// =============================
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`🚀 API rodando na porta ${PORT}`));
