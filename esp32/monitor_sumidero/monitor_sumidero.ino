// monitor_sumidero.ino
// ESP32-S3 + sensor ultrasonico AJ-SR04M -> envia la distancia a la API en Railway por HTTPS.
// Librerias: WiFi y HTTPClient (vienen con el core ESP32), ArduinoJson v7 (Library Manager).
//
// Datos privados (WiFi y API key): van en secrets.h, que NO se sube a GitHub.
// Copia secrets.h.example como secrets.h y completalo.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "secrets.h"  // WIFI_SSID, WIFI_PASS, API_KEY

// ---------- CAMBIAR ESTOS DATOS ----------
const char* SERVER_URL  = "https://monitor-sumidero-production.up.railway.app/api/mediciones";  // URL completa de la ruta, con https://
const char* DISPOSITIVO = "esp32-sumidero";
// -----------------------------------------

// Pines del sensor (ECHO pasa por un divisor de voltaje: el sensor va a 5 V)
const int PIN_TRIG = 5;
const int PIN_ECHO = 4;

// Rango util del AJ-SR04M: bajo ~20 cm no mide (zona ciega), sobre ~600 cm no llega
const float DIST_MIN_CM = 20.0;
const float DIST_MAX_CM = 600.0;

const unsigned long INTERVALO_MS = 10000;  // enviar cada 10 s
unsigned long ultimoEnvio = 0;

void conectarWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Conectando a WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Conectado. IP: ");
  Serial.println(WiFi.localIP());
}

// Una sola lectura del sensor, en cm. Devuelve -1 si no hubo eco valido.
float medirUnaVez() {
  // Pulso de disparo: TRIG en alto 20 microsegundos
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(5);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(20);
  digitalWrite(PIN_TRIG, LOW);

  // Cuanto tiempo vuelve el eco (maximo 40 ms, que equivale a unos 6,8 m)
  unsigned long duracion = pulseIn(PIN_ECHO, HIGH, 40000);
  if (duracion == 0) return -1;  // no volvio el eco

  // Velocidad del sonido: 0,0343 cm por microsegundo. Se divide por 2 (ida y vuelta)
  float cm = duracion * 0.0343 / 2.0;
  if (cm < DIST_MIN_CM || cm > DIST_MAX_CM) return -1;  // fuera de rango: se descarta
  return cm;
}

// Toma 5 lecturas y devuelve la mediana (la del medio), para ignorar ecos falsos.
// Devuelve -1 si menos de 3 lecturas fueron validas.
float leerDistancia() {
  float lecturas[5];
  int validas = 0;
  for (int i = 0; i < 5; i++) {
    float d = medirUnaVez();
    if (d > 0) lecturas[validas++] = d;
    delay(60);  // pausa para que no se mezclen los ecos
  }
  if (validas < 3) return -1;

  // Ordenar las lecturas validas de menor a mayor (pocas, asi que basta este metodo simple)
  for (int i = 0; i < validas - 1; i++) {
    for (int j = i + 1; j < validas; j++) {
      if (lecturas[j] < lecturas[i]) {
        float t = lecturas[i]; lecturas[i] = lecturas[j]; lecturas[j] = t;
      }
    }
  }
  return lecturas[validas / 2];
}

void enviarMedicion(float distancia) {
  WiFiClientSecure cliente;
  cliente.setInsecure();  // cifra, pero no verifica el certificado (ver guia)

  HTTPClient http;
  http.begin(cliente, SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);

  // Arma el JSON que espera el servidor
  JsonDocument doc;
  doc["dispositivo"] = DISPOSITIVO;
  doc["distancia_cm"] = round(distancia * 10) / 10.0;  // 1 decimal
  doc["bateria_v"] = nullptr;  // sin medicion de bateria (powerbank por USB)
  String cuerpo;
  serializeJson(doc, cuerpo);

  int codigo = http.POST(cuerpo);
  Serial.printf("POST %s -> %d\n", cuerpo.c_str(), codigo);
  if (codigo > 0) {
    Serial.println(http.getString());  // respuesta del servidor, ej. {"ok":true,"id":7,"nivel_cm":57.7}
  } else {
    Serial.printf("Error: %s\n", http.errorToString(codigo).c_str());
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  digitalWrite(PIN_TRIG, LOW);
  conectarWiFi();
}

void loop() {
  // Si se cayo el WiFi, reconectar
  if (WiFi.status() != WL_CONNECTED) {
    conectarWiFi();
  }

  // Cada INTERVALO_MS: medir y enviar (millis() en vez de delay para no bloquear)
  if (millis() - ultimoEnvio >= INTERVALO_MS) {
    ultimoEnvio = millis();
    float distancia = leerDistancia();
    if (distancia < 0) {
      Serial.println("Lectura no valida (sin eco o fuera de rango). No se envia.");
    } else {
      Serial.printf("Distancia: %.1f cm\n", distancia);
      enviarMedicion(distancia);
    }
  }
}
