
app.post("/api/v1/asignaciones", async (req, res) => {

    const transaction = new sql.Transaction(pool);

    try {
        console.log("[POST] Procesando asignaciones");

        const datos = req.body;

        // Validar estructura principal
        if (!Array.isArray(datos) || datos.length === 0) {
            return res.status(400).json({
                ok: false,
                mensaje: "El JSON debe contener un arreglo de clientes"
            });
        }

        const clientesVistos = new Set();

        // Validar todos los registros antes de iniciar la transacción
        for (const item of datos) {

            if (!item.cliente || !item.cliente.numero) {
                return res.status(400).json({
                    ok: false,
                    mensaje: "Cada registro debe contener cliente.numero"
                });
            }

            const numero = String(item.cliente.numero).trim();

            if (clientesVistos.has(numero)) {
                return res.status(400).json({
                    ok: false,
                    mensaje: "NumeroCliente duplicado dentro del mismo archivo: " + numero
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

        await transaction.begin();

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

            if (ingresos !== null && !Number.isFinite(ingresos)) {
                throw new Error(
                    "Ingresos inválidos para cliente " + numero
                );
            }

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
                req.headers["x-filename"] || "archivo.json"
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

        return res.json({
            ok: true,
            mensaje: "Asignaciones procesadas correctamente",
            clientesRecibidos: datos.length,
            clientesInsertados: insertados,
            clientesActualizados: actualizados
        });

    } catch (error) {

        try {
            await transaction.rollback();
        } catch (errorRollback) {
            console.error("Error al revertir transacción:", errorRollback);
        }

        console.error("Error procesando JSON:", error);

        return res.status(500).json({
            ok: false,
            mensaje: "Error al procesar asignaciones",
            detalle: error.message
        });
    }
});
