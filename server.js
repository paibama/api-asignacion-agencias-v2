
const express = require("express");
const sql = require("mssql");

const app = express();
const PORT = process.env.PORT || 3000;

// ======================================
// RECIBIR JSON Y CONSERVAR CUERPO ORIGINAL
// ======================================

app.use(express.json({
    limit: "20mb",
    verify: (req, res, buf) => {
        req.rawBody = buf.toString("utf8");
    }
}));

// ======================================
// CONFIGURACION SQL SERVER 2008 SP2
// ======================================

const dbConfig = {
    server: process.env.DB_SERVER,
    port: Number(process.env.DB_PORT || 1433),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    options: {
        encrypt: process.env.DB_ENCRYPT === "true",
        trustServerCertificate: process.env.DB_TRUST_CERT === "true",
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
// FUNCIONES DE VALIDACION
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

function texto(valor, maximo, campo) {
    if (valor === undefined || valor === null || valor === "") {
        return null;
    }

    const resultado = String(valor);

    if (resultado.length > maximo) {
        throw new Error(
            campo + " excede el máximo de " + maximo + " caracteres"
        );
    }

    return resultado;
}

function decimal(valor, campo) {
    if (valor === undefined || valor === null || valor === "") {
        return null;
    }

    const numero = Number(valor);

    if (!Number.isFinite(numero) ||
        Math.abs(numero) >= 10000000000000000) {
        throw new Error(campo + " contiene un valor decimal inválido");
    }

    return numero;
}

function entero(valor, campo) {
    if (valor === undefined || valor === null || valor === "") {
        return null;
    }

    const numero = Number(valor);

    if (!Number.isSafeInteger(numero)) {
        throw new Error(campo + " debe ser un número entero válido");
    }

    return numero;
}

function arreglo(valor, campo, numeroCliente) {
    if (valor === undefined || valor === null) {
        return [];
    }

    if (!Array.isArray(valor)) {
        throw new Error(
            campo + " debe ser un arreglo para el cliente " + numeroCliente
        );
    }

    for (const elemento of valor) {
        if (!elemento || typeof elemento !== "object" ||
            Array.isArray(elemento)) {
            throw new Error(
                "Elemento inválido en " + campo +
                " para el cliente " + numeroCliente
            );
        }
    }

    return valor;
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
        console.error("Error SQL:", error);

        res.status(503).json({
            ok: false,
            mensaje: "Sin conexión a SQL Server",
            detalle: error.message
        });
    }
});

// ======================================
// RECIBIR ASIGNACIONES
// GUARDA HISTORICO Y DESGLOSA LOS DATOS
// ======================================

app.post("/api/v1/asignaciones", autenticar, async (req, res) => {

    let transaction;
    let transactionIniciada = false;

    try {
        console.log("[POST] Recibiendo JSON de asignaciones");

        const datos = req.body;

        if (!Array.isArray(datos) || datos.length === 0) {
            return res.status(400).json({
                ok: false,
                mensaje: "El JSON debe contener un arreglo de clientes"
            });
        }

        // Validar toda la estructura antes de insertar
        const clientesValidados = [];

        for (const item of datos) {

            if (!item || typeof item !== "object" || Array.isArray(item)) {
                throw new Error("Cada elemento debe ser un objeto de cliente");
            }

            if (!item.cliente ||
                item.cliente.numero === undefined ||
                item.cliente.numero === null ||
                String(item.cliente.numero).trim() === "") {
                throw new Error("Cada registro debe contener cliente.numero");
            }

            const cliente = item.cliente;
            const numero = String(cliente.numero).trim();

            if (numero.length > 30) {
                throw new Error(
                    "NumeroCliente excede 30 caracteres: " + numero
                );
            }

            const contratos = arreglo(item.contrato, "contrato", numero);
            const telefonos = arreglo(item.telefono, "telefono", numero);
            const direcciones = arreglo(item.direccion, "direccion", numero);

            clientesValidados.push({
                cliente,
                numero,
                contratos,
                telefonos,
                direcciones
            });
        }

        // Nombre del archivo enviado en el encabezado
        const nombreArchivo = texto(
            req.headers["x-filename"] || "archivo.json",
            510,
            "NombreArchivo"
        );

        // Guardar exactamente el texto JSON recibido
        const contenidoJSON = req.rawBody || JSON.stringify(datos);

        const pool = await getPool();

        transaction = new sql.Transaction(pool);

        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
        transactionIniciada = true;

        // ======================================
        // 1. GUARDAR RECEPCION ORIGINAL
        // ======================================

        const recepcionRequest = new sql.Request(transaction);

        recepcionRequest.input(
            "NombreArchivo",
            sql.NVarChar(510),
            nombreArchivo
        );

        recepcionRequest.input(
            "ContenidoJSON",
            sql.NVarChar(sql.MAX),
            contenidoJSON
        );

        const recepcionResultado = await recepcionRequest.query(`
            INSERT INTO dbo.Recepciones
            (
                NombreArchivo,
                ContenidoJSON
            )
            VALUES
            (
                @NombreArchivo,
                @ContenidoJSON
            );

            SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS IdRecepcion;
        `);

        const idRecepcion = recepcionResultado.recordset[0].IdRecepcion;

        let clientesInsertados = 0;
        let contratosInsertados = 0;
        let telefonosInsertados = 0;
        let direccionesInsertadas = 0;

        // ======================================
        // 2. PROCESAR CADA CLIENTE
        // ======================================

        for (const item of clientesValidados) {

            const cliente = item.cliente;

            const ingresos = decimal(
                cliente.ingresos,
                "Ingresos del cliente " + item.numero
            );

            const clienteRequest = new sql.Request(transaction);

            clienteRequest.input(
                "IdRecepcion",
                sql.BigInt,
                idRecepcion
            );

            clienteRequest.input(
                "NumeroCliente",
                sql.NVarChar(30),
                item.numero
            );

            clienteRequest.input(
                "Nombre",
                sql.NVarChar(200),
                texto(cliente.nombre, 200, "Nombre")
            );

            clienteRequest.input(
                "CURP",
                sql.NVarChar(25),
                texto(cliente.curp, 25, "CURP")
            );

            clienteRequest.input(
                "RFC",
                sql.NVarChar(20),
                texto(cliente.rfc, 20, "RFC")
            );

            clienteRequest.input(
                "Correo",
                sql.NVarChar(200),
                texto(cliente.correo, 200, "Correo")
            );

            clienteRequest.input(
                "Ingresos",
                sql.Decimal(18, 2),
                ingresos
            );

            clienteRequest.input(
                "Sexo",
                sql.NVarChar(30),
                texto(cliente.sexo, 30, "Sexo")
            );

            const clienteResultado = await clienteRequest.query(`
                INSERT INTO dbo.RecepcionClientes
                (
                    IdRecepcion,
                    NumeroCliente,
                    Nombre,
                    CURP,
                    RFC,
                    Correo,
                    Ingresos,
                    Sexo
                )
                VALUES
                (
                    @IdRecepcion,
                    @NumeroCliente,
                    @Nombre,
                    @CURP,
                    @RFC,
                    @Correo,
                    @Ingresos,
                    @Sexo
                );

                SELECT CAST(SCOPE_IDENTITY() AS BIGINT)
                    AS IdClienteRecepcion;
            `);

            const idClienteRecepcion =
                clienteResultado.recordset[0].IdClienteRecepcion;

            clientesInsertados++;

            // ======================================
            // 3. INSERTAR TODOS LOS CONTRATOS
            // ======================================

            for (const contrato of item.contratos) {

                const r = new sql.Request(transaction);

                r.input("IdClienteRecepcion", sql.BigInt, idClienteRecepcion);
                r.input("NumeroEmpresa", sql.NVarChar(50),
                    texto(contrato.numeroEmpresa, 50, "NumeroEmpresa"));
                r.input("NumeroSucursal", sql.NVarChar(50),
                    texto(contrato.numeroSucursal, 50, "NumeroSucursal"));
                r.input("NumeroContrato", sql.NVarChar(50),
                    texto(contrato.numeroContrato, 50, "NumeroContrato"));
                r.input("NombreCliente", sql.NVarChar(200),
                    texto(contrato.nombreCliente, 200, "NombreCliente"));
                r.input("FrecuenciaPago", sql.NVarChar(50),
                    texto(contrato.frecuenciaPago, 50, "FrecuenciaPago"));
                r.input("CapitalInsoluto", sql.Decimal(18, 2),
                    decimal(contrato.capitalInsoluto, "CapitalInsoluto"));
                r.input("MontoPago", sql.Decimal(18, 2),
                    decimal(contrato.montoPago, "MontoPago"));
                r.input("MontoContener", sql.Decimal(18, 2),
                    decimal(contrato.montoContener, "MontoContener"));
                r.input("MontoAbatir", sql.Decimal(18, 2),
                    decimal(contrato.montoAbatir, "MontoAbatir"));
                r.input("MontoCorriente", sql.Decimal(18, 2),
                    decimal(contrato.montoCorriente, "MontoCorriente"));
                r.input("Bucket", sql.NVarChar(50),
                    texto(contrato.bucket, 50, "Bucket"));
                r.input("DiasVencidos", sql.Int,
                    entero(contrato.diasVencidos, "DiasVencidos"));
                r.input("Segmento", sql.NVarChar(100),
                    texto(contrato.segmento, 100, "Segmento"));
                r.input("TipoProducto", sql.NVarChar(100),
                    texto(contrato.tipoProducto, 100, "TipoProducto"));
                r.input("NumPagosVdosProy", sql.Int,
                    entero(contrato.numPagosVdosProy, "NumPagosVdosProy"));
                r.input("SaldoContableInicial", sql.Decimal(18, 2),
                    decimal(contrato.saldoContableInicial, "SaldoContableInicial"));

                await r.query(`
                    INSERT INTO dbo.RecepcionContratos
                    (
                        IdClienteRecepcion,
                        NumeroEmpresa,
                        NumeroSucursal,
                        NumeroContrato,
                        NombreCliente,
                        FrecuenciaPago,
                        CapitalInsoluto,
                        MontoPago,
                        MontoContener,
                        MontoAbatir,
                        MontoCorriente,
                        Bucket,
                        DiasVencidos,
                        Segmento,
                        TipoProducto,
                        NumPagosVdosProy,
                        SaldoContableInicial
                    )
                    VALUES
                    (
                        @IdClienteRecepcion,
                        @NumeroEmpresa,
                        @NumeroSucursal,
                        @NumeroContrato,
                        @NombreCliente,
                        @FrecuenciaPago,
                        @CapitalInsoluto,
                        @MontoPago,
                        @MontoContener,
                        @MontoAbatir,
                        @MontoCorriente,
                        @Bucket,
                        @DiasVencidos,
                        @Segmento,
                        @TipoProducto,
                        @NumPagosVdosProy,
                        @SaldoContableInicial
                    );
                `);

                contratosInsertados++;
            }

            // ======================================
            // 4. INSERTAR TODOS LOS TELEFONOS
            // ======================================

            for (const telefono of item.telefonos) {

                const r = new sql.Request(transaction);

                r.input("IdClienteRecepcion", sql.BigInt, idClienteRecepcion);
                r.input("TipoTelefono", sql.NVarChar(50),
                    texto(telefono.tipoTelefono, 50, "TipoTelefono"));
                r.input("Numero", sql.NVarChar(50),
                    texto(telefono.numero, 50, "NumeroTelefono"));

                await r.query(`
                    INSERT INTO dbo.RecepcionTelefonos
                    (
                        IdClienteRecepcion,
                        TipoTelefono,
                        Numero
                    )
                    VALUES
                    (
                        @IdClienteRecepcion,
                        @TipoTelefono,
                        @Numero
                    );
                `);

                telefonosInsertados++;
            }

            // ======================================
            // 5. INSERTAR TODAS LAS DIRECCIONES
            // ======================================

            for (const direccion of item.direcciones) {

                const r = new sql.Request(transaction);

                r.input("IdClienteRecepcion", sql.BigInt, idClienteRecepcion);
                r.input("Direccion", sql.NVarChar(300),
                    texto(direccion.direccion, 300, "Direccion"));
                r.input("Colonia", sql.NVarChar(150),
                    texto(direccion.colonia, 150, "Colonia"));
                r.input("CP", sql.NVarChar(10),
                    texto(direccion.cp, 10, "CP"));
                r.input("Estado", sql.NVarChar(100),
                    texto(direccion.estado, 100, "Estado"));
                r.input("TipoDireccion", sql.NVarChar(50),
                    texto(direccion.tipoDireccion, 50, "TipoDireccion"));

                await r.query(`
                    INSERT INTO dbo.RecepcionDirecciones
                    (
                        IdClienteRecepcion,
                        Direccion,
                        Colonia,
                        CP,
                        Estado,
                        TipoDireccion
                    )
                    VALUES
                    (
                        @IdClienteRecepcion,
                        @Direccion,
                        @Colonia,
                        @CP,
                        @Estado,
                        @TipoDireccion
                    );
                `);

                direccionesInsertadas++;
            }
        }

// ======================================
// 6. GENERAR LAYOUT CONSOLIDADO
// ======================================

const layoutRequest = new sql.Request(transaction);

layoutRequest.input(
    "IdClienteRecepcion",
    sql.BigInt,
    idClienteRecepcion
);

await layoutRequest.query(`
    INSERT INTO dbo.LayoutAsignaciones
    (
        IdRecepcion,
        IdClienteRecepcion,
        NumeroCliente,
        Nombre,
        CURP,
        RFC,
        Correo,
        Ingresos,
        Sexo,
        NumeroEmpresa,
        NumeroSucursal,
        NumeroContrato,
        NombreCliente,
        FrecuenciaPago,
        CapitalInsoluto,
        MontoPago,
        MontoContener,
        MontoAbatir,
        MontoCorriente,
        Bucket,
        DiasVencidos,
        Segmento,
        TipoProducto,
        NumPagosVdosProy,
        SaldoContableInicial,
        Telefonos,
        Direcciones,
        NombreArchivo,
        FechaRegistro,
        ContenidoJSON
    )
    SELECT
        C.IdRecepcion,
        C.IdClienteRecepcion,
        C.NumeroCliente,
        C.Nombre,
        C.CURP,
        C.RFC,
        C.Correo,
        C.Ingresos,
        C.Sexo,
        CT.NumeroEmpresa,
        CT.NumeroSucursal,
        CT.NumeroContrato,
        CT.NombreCliente,
        CT.FrecuenciaPago,
        CT.CapitalInsoluto,
        CT.MontoPago,
        CT.MontoContener,
        CT.MontoAbatir,
        CT.MontoCorriente,
        CT.Bucket,
        CT.DiasVencidos,
        CT.Segmento,
        CT.TipoProducto,
        CT.NumPagosVdosProy,
        CT.SaldoContableInicial,
        T.Telefonos,
        D.Direcciones,
        R.NombreArchivo,
        R.FechaRegistro,
        R.ContenidoJSON
    FROM dbo.RecepcionClientes C
    INNER JOIN dbo.Recepciones R
        ON C.IdRecepcion = R.IdRecepcion
    LEFT JOIN dbo.RecepcionContratos CT
        ON C.IdClienteRecepcion = CT.IdClienteRecepcion
    OUTER APPLY
    (
        SELECT STUFF((
            SELECT ' | ' +
                ISNULL(T2.TipoTelefono, '') +
                ': ' + ISNULL(T2.Numero, '')
            FROM dbo.RecepcionTelefonos T2
            WHERE T2.IdClienteRecepcion = C.IdClienteRecepcion
            FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'), 1, 3, '') AS Telefonos
    ) T
    OUTER APPLY
    (
        SELECT STUFF((
            SELECT ' | ' +
                ISNULL(D2.TipoDireccion, '') +
                ': ' + ISNULL(D2.Direccion, '') +
                ', ' + ISNULL(D2.Colonia, '') +
                ', ' + ISNULL(D2.Estado, '') +
                ', CP ' + ISNULL(D2.CP, '')
            FROM dbo.RecepcionDirecciones D2
            WHERE D2.IdClienteRecepcion = C.IdClienteRecepcion
            FOR XML PATH(''), TYPE
        ).value('.', 'NVARCHAR(MAX)'), 1, 3, '') AS Direcciones
    ) D
    WHERE C.IdClienteRecepcion = @IdClienteRecepcion;
`);

        // ======================================
        // CONFIRMAR TRANSACCION
        // ======================================

        await transaction.commit();
        transactionIniciada = false;

        console.log("[POST] Recepcion guardada:", idRecepcion);

        return res.json({
            ok: true,
            mensaje: "JSON recibido y almacenado correctamente",
            idRecepcion: idRecepcion,
            clientesRecibidos: clientesInsertados,
            contratosInsertados: contratosInsertados,
            telefonosInsertados: telefonosInsertados,
            direccionesInsertadas: direccionesInsertadas,
            jsonOriginalConservado: true
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
// CONSULTA HISTORICA DE CLIENTE
// NUEVA RUTA V2
// ======================================

app.get("/api/v2/clientes/:numero", autenticar, async (req, res) => {

    try {
        const pool = await getPool();

        const resultado = await pool.request()
            .input("NumeroCliente", sql.NVarChar(30), req.params.numero)
            .query(`
                SELECT
                    C.*,
                    R.NombreArchivo,
                    R.FechaRegistro,
                    R.ContenidoJSON
                FROM dbo.RecepcionClientes C
                INNER JOIN dbo.Recepciones R
                    ON C.IdRecepcion = R.IdRecepcion
                WHERE C.NumeroCliente = @NumeroCliente
                ORDER BY C.IdClienteRecepcion DESC;
            `);

        if (resultado.recordset.length === 0) {
            return res.status(404).json({
                ok: false,
                mensaje: "Cliente no encontrado en el historial"
            });
        }

        const historial = [];

        for (const cliente of resultado.recordset) {

            const id = cliente.IdClienteRecepcion;

            const [contratos, telefonos, direcciones] = await Promise.all([

                pool.request()
                    .input("IdClienteRecepcion", sql.BigInt, id)
                    .query(`
                        SELECT *
                        FROM dbo.RecepcionContratos
                        WHERE IdClienteRecepcion = @IdClienteRecepcion;
                    `),

                pool.request()
                    .input("IdClienteRecepcion", sql.BigInt, id)
                    .query(`
                        SELECT *
                        FROM dbo.RecepcionTelefonos
                        WHERE IdClienteRecepcion = @IdClienteRecepcion;
                    `),

                pool.request()
                    .input("IdClienteRecepcion", sql.BigInt, id)
                    .query(`
                        SELECT *
                        FROM dbo.RecepcionDirecciones
                        WHERE IdClienteRecepcion = @IdClienteRecepcion;
                    `)
            ]);

            historial.push({
                recepcion: {
                    idRecepcion: cliente.IdRecepcion,
                    nombreArchivo: cliente.NombreArchivo,
                    fechaRegistro: cliente.FechaRegistro
                },
                cliente: {
                    numero: cliente.NumeroCliente,
                    nombre: cliente.Nombre,
                    curp: cliente.CURP,
                    rfc: cliente.RFC,
                    correo: cliente.Correo,
                    ingresos: cliente.Ingresos,
                    sexo: cliente.Sexo
                },
                contrato: contratos.recordset,
                telefono: telefonos.recordset,
                direccion: direcciones.recordset,
                contenidoJSONOriginal: cliente.ContenidoJSON
            });
        }

        return res.json({
            ok: true,
            numeroCliente: req.params.numero,
            recepcionesEncontradas: historial.length,
            historial: historial
        });

    } catch (error) {
        console.error("Error consultando historial:", error);

        return res.status(500).json({
            ok: false,
            mensaje: "Error al consultar historial",
            detalle: error.message
        });
    }
});

// ======================================
// CONSULTA ANTERIOR DE CLIENTES
// SE CONSERVA PARA COMPATIBILIDAD
// ======================================

app.get("/api/v1/clientes/:numero", autenticar, async (req, res) => {

    try {
        const pool = await getPool();

        const resultado = await pool.request()
            .input("NumeroCliente", sql.NVarChar(30), req.params.numero)
            .query(`
                SELECT *
                FROM dbo.ClientesAsignacion
                WHERE NumeroCliente = @NumeroCliente;
            `);

        if (resultado.recordset.length === 0) {
            return res.status(404).json({
                ok: false,
                mensaje: "Cliente no encontrado en la tabla anterior"
            });
        }

        const cliente = resultado.recordset[0];

        return res.json({
            ok: true,
            cliente: {
                ...cliente,
                contrato: JSON.parse(cliente.ContratoJSON || "[]"),
                telefono: JSON.parse(cliente.TelefonoJSON || "[]"),
                direccion: JSON.parse(cliente.DireccionJSON || "[]")
            }
        });

    } catch (error) {
        console.error("Error consultando cliente anterior:", error);

        return res.status(500).json({
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

