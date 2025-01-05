/***********************
 * index.js
 **********************/
const express = require('express');
const axios = require('axios');
const mysql = require('mysql2/promise'); // <-- para usar MySQL con Promises

// ====== Configuración de variables de entorno ======
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "MiSecreto123"; 
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "TU_TOKEN_DE_META"; 
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "523354814195393"; 
// Cambia por tu phone_number_id real.
// En logs viste algo como "phone_number_id": "523354814195393".

// (Opcional) Filtra mensajes para que solo respondas a TU número personal
const MY_WHATSAPP_NUMBER = "529983214356"; 
// Ajusta con tu número real (sin +, con 52 de país para México).

// ====== Conexión a la Base de Datos MySQL (Railway) ======
/*
   En Railway, tras crear el plugin MySQL, tendrás variables como:
   MYSQLHOST, MYSQLDATABASE, MYSQLUSER, MYSQLPASSWORD, MYSQLPORT
   (puede que MYSQLPORT no sea necesaria si es el puerto por defecto 3306).
*/
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  database: process.env.MYSQLDATABASE,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  port: process.env.MYSQLPORT || 3306, // si tu plugin define un puerto distinto, úsalo
});

// Función para inicializar la tabla "tareas"
async function initDB() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS tareas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      descripcion VARCHAR(255) NOT NULL,
      hecha TINYINT DEFAULT 0
    )
  `;
  try {
    await pool.query(createTableQuery);
    console.log("Tabla 'tareas' (MySQL) creada/verificada correctamente.");
  } catch (error) {
    console.error("Error al crear/verificar la tabla 'tareas':", error);
  }
}
initDB(); // ejecutamos al inicio

// ====== Funciones para manejar las tareas ======

// Agregar una tarea
async function agregarTarea(descripcion) {
  const [result] = await pool.query(
    "INSERT INTO tareas (descripcion, hecha) VALUES (?, 0)",
    [descripcion]
  );
  // result.insertId -> ID autoincremental de la tarea insertada
  return result.insertId; 
}

// Listar tareas pendientes
async function listarTareas() {
  const [rows] = await pool.query(
    "SELECT * FROM tareas WHERE hecha = 0"
  );
  return rows;
}

// Marcar una tarea como hecha
async function marcarTareaHecha(idTarea) {
  const [result] = await pool.query(
    "UPDATE tareas SET hecha = 1 WHERE id = ?",
    [idTarea]
  );
  // result.affectedRows -> cuántas filas se modificaron
  return result.affectedRows;
}

// ====== Inicializamos la app Express ======
const app = express();
app.use(express.json()); // para parsear JSON en req.body

// ====== Ruta GET /webhook (verificación del token) ======
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado con éxito');
    return res.status(200).send(challenge);
  } else {
    console.log('Error de verificación de webhook');
    return res.sendStatus(403);
  }
});

// ====== Ruta POST /webhook (recepción de mensajes entrantes) ======
app.post('/webhook', async (req, res) => {
  console.log('*** Mensaje entrante ***');
  console.log(JSON.stringify(req.body, null, 2));

  if (req.body.object) {
    const entry = req.body.entry && req.body.entry[0];
    const changes = entry.changes && entry.changes[0];
    const value = changes.value;
    const messageObject = value.messages && value.messages[0];

    if (messageObject) {
      // 1. Extraemos el número remitente y el texto
      const from = messageObject.from; // Ej: "529983214356"
      const textUser = (messageObject.text && messageObject.text.body) || ""; 
      const textLower = textUser.toLowerCase().trim();

      // (Opcional) Si quieres responder SÓLO a tu número personal
      if (from !== MY_WHATSAPP_NUMBER) {
        console.log("Mensaje de otro número. Se ignora.");
        return res.sendStatus(200);
      }

      // 2. Lógica de parsing de comandos
      //   - "hello"/"hola"
      //   - "/tarea <desc>"
      //   - "/listar"
      //   - "/done <id>"
      if (textLower === "hello" || textLower === "hola") {
        await sendWhatsAppMessage(from, "¡Hola! Soy tu bot de Mecatrónica. ¿En qué puedo ayudarte?");
      } 
      else if (textLower.startsWith("/tarea ")) {
        const descripcion = textUser.slice(7).trim(); // lo que viene tras "/tarea "
        if (!descripcion) {
          await sendWhatsAppMessage(from, "Uso: /tarea <descripción>");
        } else {
          try {
            const newId = await agregarTarea(descripcion);
            await sendWhatsAppMessage(from, `Tarea agregada con ID: ${newId}`);
          } catch (error) {
            console.error(error);
            await sendWhatsAppMessage(from, "Error al agregar la tarea.");
          }
        }
      }
      else if (textLower === "/listar") {
        try {
          const tareasPendientes = await listarTareas();
          if (tareasPendientes.length === 0) {
            await sendWhatsAppMessage(from, "No hay tareas pendientes.");
          } else {
            let respuesta = "Tareas pendientes:\n";
            tareasPendientes.forEach(t => {
              respuesta += `#${t.id} - ${t.descripcion}\n`;
            });
            await sendWhatsAppMessage(from, respuesta);
          }
        } catch (error) {
          console.error(error);
          await sendWhatsAppMessage(from, "Error al listar las tareas.");
        }
      }
      else if (textLower.startsWith("/done ")) {
        const idString = textUser.slice(6).trim();
        const idNum = parseInt(idString, 10);

        if (isNaN(idNum)) {
          await sendWhatsAppMessage(from, "ID de tarea inválido. Usa /done <número>.");
        } else {
          try {
            const changes = await marcarTareaHecha(idNum);
            if (changes > 0) {
              await sendWhatsAppMessage(from, `Tarea #${idNum} marcada como hecha.`);
            } else {
              await sendWhatsAppMessage(from, `No encontré la tarea #${idNum} o ya está hecha.`);
            }
          } catch (error) {
            console.error(error);
            await sendWhatsAppMessage(from, "Error al marcar la tarea como hecha.");
          }
        }
      }
      else {
        // Respuesta por defecto si no coincide con un comando
        await sendWhatsAppMessage(from, `Recibí tu mensaje: "${textUser}"\nComandos: /tarea, /listar, /done <id>, etc.`);
      }
    }
  }

  // Siempre respondemos 200 para que WhatsApp sepa que recibimos el hook
  res.sendStatus(200);
});

// ====== Ruta GET / para mostrar algo en la raíz ======
app.get('/', (req, res) => {
  res.send('¡Hola! El servidor con MySQL está funcionando en Railway :)');
});

// ====== Función para enviar mensajes usando la API de WhatsApp ======
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

// ====== Levantamos el servidor ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
