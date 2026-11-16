// server.js - API para el monitor de nivel del sumidero
// Flujo: ESP32 -> POST HTTPS -> este servidor -> base de datos PostgreSQL

// Lee las variables del archivo .env (solo en tu PC; en Railway vienen del panel)
require("dotenv").config();
const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
// Permite leer el cuerpo de las peticiones en formato JSON
app.use(express.json());
// Sirve los archivos de la carpeta "public" (ahi ira la pagina web mas adelante)
app.use(express.static(path.join(__dirname, "public")));

// ---------- Conexion a la base de datos (Aiven exige SSL) ----------
const pool = new Pool({
  // Quitamos lo que va despues de "?" (ej. ?sslmode=require) porque el SSL
  // lo configuramos aqui abajo
  connectionString: (process.env.DATABASE_URL || "").split("?")[0],
  // Si tenemos el certificado de Aiven, lo usamos para verificar el servidor.
  // En la variable los saltos de linea vienen escritos como "\n", asi que
  // los convertimos en saltos de linea reales.
  ssl: process.env.DB_CA_CERT
    ? { ca: process.env.DB_CA_CERT.replace(/\n/g, "\n") }
    : { rejectUnauthorized: false }, // sin certificado: cifra, pero no verifica
  max: 5, // maximo 5 conexiones abiertas a la vez
});

// Altura desde el sensor hasta el fondo del sumidero (en cm)
const ALTURA_SENSOR_CM = parseFloat(process.env.ALTURA_SENSOR_CM);

// Crea la tabla la primera vez; si ya existe, no hace nada
async function crearTabla() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mediciones (
      id SERIAL PRIMARY KEY,
      dispositivo VARCHAR(50) NOT NULL,
      distancia_cm REAL NOT NULL,
      nivel_cm REAL NOT NULL,
      bateria_v REAL,
      creado_en TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("Tabla 'mediciones' lista");
}

// ---------- Seguridad minima: clave compartida con el ESP32 ----------
// Si el header x-api-key no coincide con API_KEY, se rechaza con 401
function revisarClave(req, res, next) {
  if (req.get("x-api-key") !== process.env.API_KEY) {
    return res.status(401).json({ error: "API key invalida" });
  }
  next(); // la clave es correcta: sigue a la ruta
}

// ---------- Rutas ----------

// Prueba rapida: ¿el servidor responde y llega a la base de datos?
app.get("/api/salud", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "conectada" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// El ESP32 manda: {"dispositivo":"esp32-sumidero","distancia_cm":42.3,"bateria_v":3.9}
app.post("/api/mediciones", revisarClave, async (req, res) => {
  const { dispositivo, distancia_cm, bateria_v } = req.body;

  // 1) Validar los datos que llegan; si algo esta mal, respondemos 400
  if (!dispositivo || typeof distancia_cm !== "number") {
    return res.status(400).json({ error: "Falta 'dispositivo' o 'distancia_cm' no es numero" });
  }
  // La bateria es opcional: puede no venir, venir null, o ser un numero
  if (bateria_v !== undefined && bateria_v !== null && typeof bateria_v !== "number") {
    return res.status(400).json({ error: "'bateria_v' debe ser numero o null" });
  }
  // Sin la altura del sensor no podemos calcular el nivel: es un error del servidor
  if (isNaN(ALTURA_SENSOR_CM)) {
    return res.status(500).json({ error: "Falta configurar ALTURA_SENSOR_CM en el servidor" });
  }

  // 2) Calcular el nivel: altura del sensor - distancia medida (nunca menor a 0),
  //    redondeado a 1 decimal
  const nivel_cm = Math.max(0, Math.round((ALTURA_SENSOR_CM - distancia_cm) * 10) / 10);

  // 3) Guardar en la base. Los $1, $2... evitan inyeccion SQL: los valores
  //    se mandan aparte y nunca se pegan dentro del texto de la consulta
  try {
    const r = await pool.query(
      "INSERT INTO mediciones (dispositivo, distancia_cm, nivel_cm, bateria_v) VALUES ($1, $2, $3, $4) RETURNING id",
      [dispositivo, distancia_cm, nivel_cm, bateria_v ?? null]
    );
    res.status(201).json({ ok: true, id: r.rows[0].id, nivel_cm });
  } catch (err) {
    console.error(err); // el detalle queda en el log, no se lo mostramos al cliente
    res.status(500).json({ error: "Error al guardar" });
  }
});

// Devuelve las ultimas mediciones, la mas nueva primero
// Ejemplo: /api/mediciones?limite=10 (por defecto 50, maximo 500)
app.get("/api/mediciones", async (req, res) => {
  const limite = Math.min(parseInt(req.query.limite) || 50, 500);
  try {
    const r = await pool.query("SELECT * FROM mediciones ORDER BY id DESC LIMIT $1", [limite]);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al leer" });
  }
});

// ---------- Arranque ----------
// Railway define PORT solo; en tu PC se usa 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
  if (isNaN(ALTURA_SENSOR_CM)) console.warn("OJO: falta la variable ALTURA_SENSOR_CM");
  try {
    await crearTabla();
  } catch (err) {
    console.error("No se pudo conectar a la base de datos:", err.message);
  }
});
