const express = require("express");
const sql = require("mssql");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20mb" }));

// ======================================
// CONFIGURACION DE SQL SERVER 2008 SP2
// ======================================

const dbConfig = {
    server: process.env.DB_SERVER,
    port: Number(process.env.DB_PORT || 1433),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    options: {
        encrypt: process.env.DB_ENCRYPT === "true",
        trustServerCertificate:
            process.env.DB_TRUST_CERT === "true",
        enableArithAbort: true
    },

    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    },

    connectionTimeout: 30000,
    requestTimeout: 120000
};

// Crear un solo pool de conexiones
let poolPromise;

function getPool() {
    if (!poolPromise) {
        poolPromise = new sql.ConnectionPool(dbConfig)
            .connect()
            .catch(error => {
                poolPromise = null;
                throw error;
            });
    }

    return poolPromise;
}

// ======================================
// SEGURIDAD API KEY
// ======================================

function autenticar(req, res, next) {
    const apiKey = process.env.API_KEY;

    if (!apiKey) {
        return res.status(500).json({
            ok: false,
            mensaje: "Falta configurar API_KEY en Render"
        });
    }

    if (req.headers["x-api-key"] !== apiKey) {
        return res.status(401).json({
            ok: false,
            mensaje: "No autorizado"
        });
    }

    next();
}

// ======================================
// RUTA PRINCIPAL
// ======================================

app.get("/", (req, res) => {
    res.json({
        ok: true,
        servicio: "API Asignaciones V2",
        estado: "activo"
    });
});

// ======================================
// COMPROBAR CONEXION SQL
// ======================================

app.get("/health", async (req, res) => {
    try {
        const pool = await getPool();

        await pool.request().query("SELECT 1 AS Conexion");

        res.json({
            ok: true,
            mensaje: "Conexión a SQL Server correcta"
        });

    } catch (error) {
        console.error("Error de conexión SQL:", error);

        res.status(503).json({
            ok: false,
            mensaje: "Sin conexión a SQL Server",
            detalle: error.message
        });
    }
});

// ======================================
// RECIBIR Y PROCESAR ASIGNACIONES
// ======================================

app.post("/api/v1/asignaciones", autenticar, async (req, res) => {

    let transaction;
    let transactionIniciada = false;

    try {
        console.log("[POST] Procesando asignaciones");

        const datos = req.body;

        if (!Array.isArray(datos) || datos.length === 0) {
            return res.status(400).json({
                ok: false,
                mensaje: "El JSON debe contener un arreglo de clientes"
            });
        }

        const clientesVistos = new Set();

        // Validar estructura antes de modificar la base
        for (const item of datos) {

            if (!item.cliente || item.cliente.numero === undefined ||
                item.cliente.numero === null ||
                String(item.cliente.numero).trim() === "") {

                return res.status(400).json({
                    ok: false,
                    mensaje: "Cada registro debe contener cliente.numero"
                });
            }

            const numero = String(item.cliente.numero).trim();

            if (numero.length > 30) {
                return res.status(400).json({
                    ok: false,
                    mensaje: "NumeroCliente excede 30 caracteres",
                    numeroCliente: numero
                });
            }

            if (clientesVistos.has(numero)) {
                return res.status(400).json({
                    ok: false,
                    mensaje: "NumeroCliente duplicado: " + numero
                });
            }

            clientesVistos.add(numero);

            if (!Array.isArray(item.contrato) ||
                !Array.isArray(item.telefono) ||
                !Array.isArray(item.direccion)) {

                return res.status(400).json({
                    ok: false,
                    mensaje: "Contrato, telefono y direccion deben ser arreglos",
                    numeroCliente: numero
                });
            }
        }

        // Conectar a SQL Server
        const pool = await getPool();

        transaction = new sql.Transaction(pool);

        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
        transactionIniciada = true;

        let insertados = 0;
        let actualizados = 0;

        for (const item of datos) {

            const cliente = item.cliente;
            const numero = String(cliente.numero).trim();

            const ingresos =
                cliente.ingresos === null ||
                cliente.ingresos === undefined ||
                cliente.ingresos === ""
                    ? null
                    : Number(cliente.ingresos);

            if (ingresos !== null &&
                (!Number.isFinite(ingresos) ||
                 Math.abs(ingresos) >= 100000000000000)) {

                throw new Error(
                    "Ingresos inválidos para cliente " + numero
                );
            }

            const nombreArchivo =
                String(req.headers["x-filename"] || "archivo.json")
                    .substring(0, 510);

            const request = new sql.Request(transaction);

            request.input("NumeroCliente", sql.NVarChar(30), numero);
            request.input("Nombre", sql.NVarChar(200), cliente.nombre || null);
            request.input("CURP", sql.NVarChar(25), cliente.curp || null);
            request.input("RFC", sql.NVarChar(20), cliente.rfc || null);
            request.input("Correo", sql.NVarChar(200), cliente.correo || null);
            request.input("Ingresos", sql.Decimal(18, 2), ingresos);
            request.input("Sexo", sql.NVarChar(30), cliente.sexo || null);

            request.input(
                "ContratoJSON",
                sql.NVarChar(sql.MAX),
                JSON.stringify(item.contrato)
            );

            request.input(
                "TelefonoJSON",
                sql.NVarChar(sql.MAX),
                JSON.stringify(item.telefono)
            );

            request.input(
                "DireccionJSON",
                sql.NVarChar(sql.MAX),
                JSON.stringify(item.direccion)
            );

            request.input(
                "NombreArchivo",
                sql.NVarChar(510),
                nombreArchivo
            );

            const resultado = await request.query(`
                DECLARE @Existe BIT;
                SET @Existe = 0;

                IF EXISTS (
                    SELECT 1
                    FROM dbo.ClientesAsignacion WITH (UPDLOCK, HOLDLOCK)
                    WHERE NumeroCliente = @NumeroCliente
                )
                BEGIN
                    SET @Existe = 1;

                    UPDATE dbo.ClientesAsignacion
                    SET
                        Nombre = @Nombre,
                        CURP = @CURP,
                        RFC = @RFC,
                        Correo = @Correo,
                        Ingresos = @Ingresos,
                        Sexo = @Sexo,
                        ContratoJSON = @ContratoJSON,
                        TelefonoJSON = @TelefonoJSON,
                        DireccionJSON = @DireccionJSON,
                        NombreArchivo = @NombreArchivo,
                        FechaActualizacion = GETDATE()
                    WHERE NumeroCliente = @NumeroCliente;
                END
                ELSE
                BEGIN
                    INSERT INTO dbo.ClientesAsignacion
                    (
                        NumeroCliente,
                        Nombre,
                        CURP,
                        RFC,
                        Correo,
                        Ingresos,
                        Sexo,
                        ContratoJSON,
                        TelefonoJSON,
                        DireccionJSON,
                        NombreArchivo
                    )
                    VALUES
                    (
                        @NumeroCliente,
                        @Nombre,
                        @CURP,
                        @RFC,
                        @Correo,
                        @Ingresos,
                        @Sexo,
                        @ContratoJSON,
                        @TelefonoJSON,
                        @DireccionJSON,
                        @NombreArchivo
                    );
                END;

                SELECT @Existe AS YaExistia;
            `);

            if (resultado.recordset[0].YaExistia) {
                actualizados++;
            } else {
                insertados++;
            }
        }

        await transaction.commit();
        transactionIniciada = false;

        console.log("[POST] Proceso terminado correctamente");

        return res.json({
            ok: true,
            mensaje: "Asignaciones procesadas correctamente",
            clientesRecibidos: datos.length,
            clientesInsertados: insertados,
            clientesActualizados: actualizados
        });

    } catch (error) {

        if (transaction && transactionIniciada) {
            try {
                await transaction.rollback();
            } catch (errorRollback) {
                console.error("Error al revertir:", errorRollback);
            }
        }

        console.error("Error procesando JSON:", error);

        return res.status(500).json({
            ok: false,
            mensaje: "Error al procesar asignaciones",
            detalle: error.message
        });
    }
});

// ======================================
// CONSULTAR CLIENTE POR NUMERO
// ======================================

app.get("/api/v1/clientes/:numero", autenticar, async (req, res) => {
    try {
        const pool = await getPool();

        const resultado = await pool.request()
            .input(
                "NumeroCliente",
                sql.NVarChar(30),
                req.params.numero
            )
            .query(`
                SELECT *
                FROM dbo.ClientesAsignacion
                WHERE NumeroCliente = @NumeroCliente
            `);

        if (resultado.recordset.length === 0) {
            return res.status(404).json({
                ok: false,
                mensaje: "Cliente no encontrado"
            });
        }

        const cliente = resultado.recordset[0];

        res.json({
            ok: true,
            cliente: {
                ...cliente,
                contrato: JSON.parse(cliente.ContratoJSON || "[]"),
                telefono: JSON.parse(cliente.TelefonoJSON || "[]"),
                direccion: JSON.parse(cliente.DireccionJSON || "[]")
            }
        });

    } catch (error) {
        console.error("Error consultando cliente:", error);

        res.status(500).json({
            ok: false,
            mensaje: "Error al consultar cliente",
            detalle: error.message
        });
    }
});

// ======================================
// INICIAR SERVIDOR
// ======================================

app.listen(PORT, "0.0.0.0", () => {
    console.log(`API V2 activa en el puerto ${PORT}`);
});
