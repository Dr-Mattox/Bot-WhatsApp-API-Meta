/***********************
 * index.js
 **********************/

const express = require('express');
const axios = require('axios');
const mysql = require('mysql2/promise'); 
const cron = require('node-cron'); // Para recordatorios
const { Configuration, OpenAIApi } = require("openai"); // Para ChatGPT

// ====== Variables de entorno ======
const WHATSAPP_TOKEN     = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN       = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID    = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;

// Número personal que usará el bot
const MY_WHATSAPP_NUMBER = "529983214356"; 

// ====== Configuración de OpenAI (ChatGPT) ======
const openAIConfig = new Configuration({
  apiKey: OPENAI_API_KEY,
});
const openai = new OpenAIApi(openAIConfig);

// ====== Conexión a MySQL (Railway) ======
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT || 3306
});

// ====== Inicializamos la app Express ======
const app = express();
app.use(express.json());

// =======================
//  1. DB INIT
// =======================
async function initDB_Tareas() {
  const query = `
    CREATE TABLE IF NOT EXISTS tareas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      descripcion VARCHAR(255) NOT NULL,
      hecha TINYINT DEFAULT 0
    )
  `;
  await pool.query(query);
}

async function initDB_Inventario() {
  const query = `
    CREATE TABLE IF NOT EXISTS inventario (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      stock INT DEFAULT 0,
      costo_unitario FLOAT DEFAULT 0
    )
  `;
  await pool.query(query);
}

async function initDB_Recordatorios() {
  const query = `
    CREATE TABLE IF NOT EXISTS recordatorios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      descripcion VARCHAR(255) NOT NULL,
      fecha_hora DATETIME NOT NULL,
      enviado TINYINT DEFAULT 0
    )
  `;
  await pool.query(query);
}

async function initDB_Quiz() {
  const query = `
    CREATE TABLE IF NOT EXISTS quiz_preguntas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tema VARCHAR(100) NOT NULL,
      pregunta TEXT NOT NULL,
      respuesta TEXT NOT NULL
    )
  `;
  await pool.query(query);
}

// Ejecutamos al inicio
(async () => {
  try {
    await initDB_Tareas();
    await initDB_Inventario();
    await initDB_Recordatorios();
    await initDB_Quiz();
    console.log("Tablas de DB verificadas/creadas con éxito.");
  } catch (err) {
    console.error("Error inicializando DB:", err);
  }
})();

// =======================
//  2. LÓGICA DE NEGOCIO
// =======================

// --- TAREAS ---
async function agregarTarea(descripcion) {
  const [result] = await pool.query(
    "INSERT INTO tareas (descripcion, hecha) VALUES (?, 0)",
    [descripcion]
  );
  return result.insertId;
}
async function listarTareas() {
  const [rows] = await pool.query(
    "SELECT * FROM tareas WHERE hecha = 0"
  );
  return rows;
}
async function marcarTareaHecha(idTarea) {
  const [result] = await pool.query(
    "UPDATE tareas SET hecha = 1 WHERE id=?",
    [idTarea]
  );
  return result.affectedRows;
}

// --- INVENTARIO ---
async function agregarComponente(nombre, cantidad, costo) {
  const [rows] = await pool.query(
    "SELECT * FROM inventario WHERE nombre=?",
    [nombre]
  );
  if (rows.length === 0) {
    // Insertar
    await pool.query(
      "INSERT INTO inventario (nombre, stock, costo_unitario) VALUES (?, ?, ?)",
      [nombre, cantidad, costo]
    );
    return `Componente ${nombre} agregado. Stock=${cantidad}, CostoUnit=${costo}`;
  } else {
    // Actualizar
    const nuevoStock = rows[0].stock + cantidad;
    await pool.query(
      "UPDATE inventario SET stock=?, costo_unitario=? WHERE id=?",
      [nuevoStock, costo, rows[0].id]
    );
    return `Componente ${nombre} actualizado. Stock=${nuevoStock}, CostoUnit=${costo}`;
  }
}
async function verComponente(nombre) {
  const [rows] = await pool.query(
    "SELECT * FROM inventario WHERE nombre=?",
    [nombre]
  );
  if (rows.length === 0) {
    return `No encuentro el componente "${nombre}".`;
  } else {
    const c = rows[0];
    return `Componente: ${c.nombre}\nStock: ${c.stock}\nCosto Unit: ${c.costo_unitario}`;
  }
}

// --- RECORDATORIOS ---
async function agregarRecordatorio(descripcion, fechaHora) {
  const [result] = await pool.query(
    "INSERT INTO recordatorios (descripcion, fecha_hora, enviado) VALUES (?, ?, 0)",
    [descripcion, fechaHora]
  );
  return result.insertId;
}
async function obtenerRecordatoriosPendientes() {
  const [rows] = await pool.query(`
    SELECT * FROM recordatorios
    WHERE enviado=0
      AND fecha_hora <= NOW()
  `);
  return rows;
}
async function marcarRecordatorioEnviado(id) {
  await pool.query(
    "UPDATE recordatorios SET enviado=1 WHERE id=?",
    [id]
  );
}

// node-cron: cada minuto checamos recordatorios pendientes
cron.schedule('* * * * *', async () => {
  try {
    const recordatorios = await obtenerRecordatoriosPendientes();
    for (const rec of recordatorios) {
      // Envía al número personal
      await sendWhatsAppMessage(MY_WHATSAPP_NUMBER, 
        `Recordatorio: ${rec.descripcion}`
      );
      await marcarRecordatorioEnviado(rec.id);
    }
  } catch (err) {
    console.error("Error en cron job recordatorios:", err);
  }
});

// --- QUIZ (usando ChatGPT para generar preguntas) ---
async function obtenerPreguntasPorTema(tema) {
  // O puedes guardarlas en tu DB, pero aquí demuestro usando ChatGPT
  // Preguntamos a ChatGPT: "Dame 3 preguntas sobre el tema X con sus respuestas"
  // Ajusta el prompt como gustes
  const prompt = `
  Genera 3 preguntas con sus respuestas sobre el tema "${tema}". 
  Formato JSON: [{"pregunta": "...", "respuesta": "..."}]
  `;
  try {
    const completion = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [
        {role: "user", content: prompt}
      ],
      temperature: 0.7
    });
    const content = completion.data.choices[0].message.content;
    // Intentamos parsear como JSON
    let preguntas;
    try {
      preguntas = JSON.parse(content);
    } catch (err) {
      // Si no pudo parsear, tal vez ChatGPT no respondió en JSON estricto
      // Maneja el error o ajusta tu prompt
      preguntas = [{ pregunta: "Error en parse", respuesta: content }];
    }
    return preguntas; 
  } catch (err) {
    console.error("Error llamando a ChatGPT:", err);
    return [];
  }
}

// --- INFO TÉCNICA (Consulta a ChatGPT) ---
async function consultarInfoChatGPT(tema) {
  // Preguntamos a ChatGPT "Explica sobre <tema> en ingeniería"
  const prompt = `Explica de forma concisa y técnica sobre: ${tema}.`;
  try {
    const completion = await openai.createChatCompletion({
      model: "gpt-3.5-turbo",
      messages: [{role: "user", content: prompt}],
      temperature: 0.7
    });
    const text = completion.data.choices[0].message.content;
    return text;
  } catch (err) {
    console.error("Error consultando ChatGPT:", err);
    return "No pude obtener la info. Intenta más tarde.";
  }
}

// =======================
//  3. RUTAS
// =======================

// GET /webhook -> verificar token
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado con éxito');
    return res.status(200).send(challenge);
  } else {
    console.log('Error de verificación de webhook');
    return res.sendStatus(403);
  }
});

// POST /webhook -> recibe mensajes
app.post('/webhook', async (req, res) => {
  console.log('*** Mensaje entrante ***');
  console.log(JSON.stringify(req.body, null, 2));

  if (req.body.object) {
    const entry         = req.body.entry && req.body.entry[0];
    const changes       = entry.changes && entry.changes[0];
    const value         = changes.value;
    const messageObject = value.messages && value.messages[0];

    if (messageObject) {
      const from = messageObject.from;
      const textUser  = (messageObject.text && messageObject.text.body) || "";
      const textLower = textUser.toLowerCase().trim();

      // Filtrar (solo tu número)
      if (from !== MY_WHATSAPP_NUMBER) {
        console.log("Mensaje de otro número. Se ignora.");
        return res.sendStatus(200);
      }

      // Lógica de comandos
      if (textLower === "hola" || textLower === "hello") {
        await sendWhatsAppMessage(from, 
          "¡Hola! Soy tu bot con ChatGPT. Comandos:\n" +
          "1) /tarea <desc>, /listar, /done <id>\n" +
          "2) /componente <nombre> <stock> <costo>, /vercomp <nombre>\n" +
          "3) /info <tema>\n" +
          "4) /quiz <tema>\n" +
          "5) /recordatorio <YYYY-MM-DD HH:MM> <texto>"
        );
      }
      // TAREAS
      else if (textLower.startsWith("/tarea ")) {
        const desc = textUser.slice(7).trim();
        if (!desc) {
          await sendWhatsAppMessage(from, "Uso: /tarea <descripción>");
        } else {
          try {
            const newId = await agregarTarea(desc);
            await sendWhatsAppMessage(from, 
              `Tarea agregada con ID: ${newId}`
            );
          } catch (err) {
            console.error(err);
            await sendWhatsAppMessage(from, "Error al agregar tarea.");
          }
        }
      }
      else if (textLower === "/listar") {
        try {
          const tareas = await listarTareas();
          if (tareas.length === 0) {
            await sendWhatsAppMessage(from, "No hay tareas pendientes.");
          } else {
            let respuesta = "Tareas pendientes:\n";
            tareas.forEach(t => {
              respuesta += `#${t.id} - ${t.descripcion}\n`;
            });
            await sendWhatsAppMessage(from, respuesta);
          }
        } catch (err) {
          console.error(err);
          await sendWhatsAppMessage(from, "Error al listar tareas.");
        }
      }
      else if (textLower.startsWith("/done ")) {
        const idStr = textUser.slice(6).trim();
        const idNum = parseInt(idStr, 10);
        if (isNaN(idNum)) {
          await sendWhatsAppMessage(from, "Uso: /done <id> (número).");
        } else {
          try {
            const changes = await marcarTareaHecha(idNum);
            if (changes > 0) {
              await sendWhatsAppMessage(from, 
                `Tarea #${idNum} marcada como hecha.`
              );
            } else {
              await sendWhatsAppMessage(from, 
                `No se encontró la tarea #${idNum} o ya está hecha.`
              );
            }
          } catch (err) {
            console.error(err);
            await sendWhatsAppMessage(from, "Error al marcar la tarea.");
          }
        }
      }

      // INVENTARIO
      else if (textLower.startsWith("/componente ")) {
        // /componente servo 10 100
        const args = textUser.split(" ");
        if (args.length < 4) {
          await sendWhatsAppMessage(from, 
            "Uso: /componente <nombre> <stock> <costo>"
          );
        } else {
          const nombre = args[1];
          const stock = parseInt(args[2], 10);
          const costo = parseFloat(args[3]);
          if (isNaN(stock) || isNaN(costo)) {
            await sendWhatsAppMessage(from, 
              "Valores de stock/costo inválidos."
            );
          } else {
            try {
              const msg = await agregarComponente(nombre, stock, costo);
              await sendWhatsAppMessage(from, msg);
            } catch (err) {
              console.error(err);
              await sendWhatsAppMessage(from, "Error al agregar componente.");
            }
          }
        }
      }
      else if (textLower.startsWith("/vercomp ")) {
        const nombre = textUser.slice(9).trim();
        if (!nombre) {
          await sendWhatsAppMessage(from, 
            "Uso: /vercomp <nombre>"
          );
        } else {
          try {
            const msg = await verComponente(nombre);
            await sendWhatsAppMessage(from, msg);
          } catch (err) {
            console.error(err);
            await sendWhatsAppMessage(from, "Error al consultar componente.");
          }
        }
      }

      // INFO (ChatGPT)
      else if (textLower.startsWith("/info ")) {
        const tema = textUser.slice(6).trim();
        if (!tema) {
          await sendWhatsAppMessage(from, 
            "Uso: /info <tema>"
          );
        } else {
          const info = await consultarInfoChatGPT(tema);
          await sendWhatsAppMessage(from, info);
        }
      }

      // QUIZ (ChatGPT)
      else if (textLower.startsWith("/quiz ")) {
        const tema = textUser.slice(6).trim();
        if (!tema) {
          await sendWhatsAppMessage(from, "Uso: /quiz <tema>");
        } else {
          const preguntas = await obtenerPreguntasPorTema(tema);
          if (preguntas.length === 0) {
            await sendWhatsAppMessage(from, 
              `No pude generar preguntas sobre '${tema}'.`
            );
          } else {
            // Envía las preguntas generadas
            let resp = `Preguntas de ${tema}:\n\n`;
            preguntas.forEach((p, idx) => {
              resp += `P${idx+1}: ${p.pregunta}\nRespuesta: ${p.respuesta}\n\n`;
            });
            await sendWhatsAppMessage(from, resp);
          }
        }
      }

      // RECORDATORIO
      else if (textLower.startsWith("/recordatorio ")) {
        // /recordatorio 2025-01-10 14:00 Hacer simulacion
        const resto = textUser.slice(14).trim();
        const firstSpace = resto.indexOf(" ");
        if (firstSpace < 0) {
          await sendWhatsAppMessage(from, 
            "Uso: /recordatorio <YYYY-MM-DD HH:MM> <texto>"
          );
        } else {
          const fechaHoraStr = resto.slice(0, firstSpace);
          const desc = resto.slice(firstSpace+1);
          if (!desc) {
            await sendWhatsAppMessage(from, 
              "Falta descripción."
            );
          } else {
            // Convertir a DateTime
            const fechaHora = new Date(fechaHoraStr.replace(" ", "T")+":00");
            if (isNaN(fechaHora.getTime())) {
              await sendWhatsAppMessage(from, 
                "Fecha/hora inválida (YYYY-MM-DD HH:MM)."
              );
            } else {
              const iso = fechaHora.toISOString().slice(0,19).replace("T"," ");
              try {
                const newId = await agregarRecordatorio(desc, iso);
                await sendWhatsAppMessage(from, 
                  `Recordatorio #${newId} guardado para ${iso}`
                );
              } catch (err) {
                console.error(err);
                await sendWhatsAppMessage(from, 
                  "Error al guardar recordatorio."
                );
              }
            }
          }
        }
      }

      // Por defecto
      else {
        await sendWhatsAppMessage(from,
          `No reconozco el comando.\n` +
          `Tus comandos: /tarea, /listar, /done, /componente, /vercomp, /info, /quiz, /recordatorio.`
        );
      }
    }
  }

  // Respuesta 200 a WhatsApp
  res.sendStatus(200);
});

// GET / (raiz)
app.get('/', (req, res) => {
  res.send('Servidor Bot WhatsApp con ChatGPT en Railway activo.');
});

// =======================
//  4. Función para enviar WA
// =======================
async function sendWhatsAppMessage(to, message) {
  try {
    const url = `https://graph.facebook.com/v16.0/${PHONE_NUMBER_ID}/messages`;
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      to: to, 
      text: { body: message }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log("Mensaje enviado con éxito:", response.data);
  } catch (err) {
    console.error("Error al enviar mensaje:", err.response ? err.response.data : err.message);
  }
}

// =======================
//  5. Levantar servidor
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
