// index.js
const express = require('express');
const app = express();
app.use(express.json()); // Para parsear JSON en req.body

// Variable de entorno para tu Verify Token (ejemplo). 
// Lo ideal es que la guardes en .env o en tu hosting (Railway, Render, etc.)
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "MiSecreto123";

// 1. GET /webhook para verificación
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

// 2. POST /webhook para recibir mensajes entrantes
app.post('/webhook', (req, res) => {
  // WhatsApp Cloud API envía la info en req.body
  console.log('*** Mensaje entrante ***');
  console.log(JSON.stringify(req.body, null, 2));

  // Aquí es donde procesarías los mensajes, tomarías el número del remitente, el texto, etc.
  // Ejemplo de estructura:
  // req.body.entry[0].changes[0].value.messages[0]
  // ...
  
  // Responde 200 para que WhatsApp sepa que recibiste el webhook.
  res.sendStatus(200);
});

// Inicia el servidor en un puerto
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});

app.get('/', (req, res) => {
    res.send('¡Hola! El servidor está funcionando en Railway :)');
  });
  