(() => {
  const legacyTables = [
    "products", "customers", "suppliers", "sales", "sale_items",
    "payments", "stock_movements", "expenses"
  ];
  const schema = `
    CREATE TABLE IF NOT EXISTS usuarios (
      id_usuario INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      rol TEXT NOT NULL CHECK (rol IN ('ADMIN', 'CAJERO', 'BODEGUERO')),
      activo INTEGER NOT NULL DEFAULT 1,
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS categorias (
      id_categoria INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL UNIQUE,
      descripcion TEXT,
      activo INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS proveedores (
      id_proveedor INTEGER PRIMARY KEY AUTOINCREMENT,
      rut_identificacion TEXT UNIQUE,
      razon_social TEXT NOT NULL,
      contacto_nombre TEXT,
      telefono TEXT,
      email TEXT,
      direccion TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS clientes (
      id_cliente INTEGER PRIMARY KEY AUTOINCREMENT,
      rut_identificacion TEXT UNIQUE,
      nombre TEXT NOT NULL,
      giro TEXT,
      telefono TEXT,
      email TEXT,
      direccion TEXT,
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS productos (
      id_producto INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE,
      codigo_barras TEXT UNIQUE,
      nombre TEXT NOT NULL,
      descripcion TEXT,
      id_categoria INTEGER,
      unidad_medida TEXT NOT NULL DEFAULT 'UN' CHECK (unidad_medida IN ('UN', 'KG', 'LT', 'MT', 'CAJA')),
      costo_promedio REAL NOT NULL DEFAULT 0 CHECK (costo_promedio >= 0),
      precio_neto REAL NOT NULL CHECK (precio_neto >= 0),
      exento_iva INTEGER NOT NULL DEFAULT 0,
      precio_venta_final REAL NOT NULL CHECK (precio_venta_final >= 0),
      stock_actual REAL NOT NULL DEFAULT 0,
      stock_minimo REAL NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1,
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id_categoria) REFERENCES categorias(id_categoria) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS compras (
      id_compra INTEGER PRIMARY KEY AUTOINCREMENT,
      id_proveedor INTEGER,
      id_usuario INTEGER NOT NULL,
      tipo_documento TEXT NOT NULL CHECK (tipo_documento IN ('FACTURA', 'BOLETA', 'GUIA_DESPACHO', 'SIN_DOC')),
      folio_documento TEXT,
      fecha_emision DATE NOT NULL DEFAULT (DATE('now')),
      total_neto REAL NOT NULL DEFAULT 0,
      total_iva REAL NOT NULL DEFAULT 0,
      total_compra REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'RECIBIDA' CHECK (estado IN ('RECIBIDA', 'ANULADA')),
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id_proveedor) REFERENCES proveedores(id_proveedor) ON DELETE SET NULL,
      FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
    );
    CREATE TABLE IF NOT EXISTS detalle_compras (
      id_detalle_compra INTEGER PRIMARY KEY AUTOINCREMENT,
      id_compra INTEGER NOT NULL,
      id_producto INTEGER NOT NULL,
      cantidad REAL NOT NULL CHECK (cantidad > 0),
      costo_unitario_neto REAL NOT NULL CHECK (costo_unitario_neto >= 0),
      subtotal_neto REAL NOT NULL,
      FOREIGN KEY (id_compra) REFERENCES compras(id_compra) ON DELETE CASCADE,
      FOREIGN KEY (id_producto) REFERENCES productos(id_producto)
    );
    CREATE TABLE IF NOT EXISTS ventas (
      id_venta INTEGER PRIMARY KEY AUTOINCREMENT,
      id_cliente INTEGER,
      id_usuario INTEGER NOT NULL,
      tipo_documento TEXT NOT NULL DEFAULT 'BOLETA' CHECK (tipo_documento IN ('BOLETA', 'FACTURA', 'TICKET_INTERNO')),
      folio_documento TEXT,
      fecha_venta DATETIME DEFAULT CURRENT_TIMESTAMP,
      subtotal_neto REAL NOT NULL DEFAULT 0,
      total_iva REAL NOT NULL DEFAULT 0,
      descuento_global REAL NOT NULL DEFAULT 0,
      total_venta REAL NOT NULL CHECK (total_venta >= 0),
      estado TEXT NOT NULL DEFAULT 'COMPLETADA' CHECK (estado IN ('COMPLETADA', 'ANULADA', 'PENDIENTE')),
      FOREIGN KEY (id_cliente) REFERENCES clientes(id_cliente) ON DELETE SET NULL,
      FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
    );
    CREATE TABLE IF NOT EXISTS detalle_ventas (
      id_detalle_venta INTEGER PRIMARY KEY AUTOINCREMENT,
      id_venta INTEGER NOT NULL,
      id_producto INTEGER NOT NULL,
      cantidad REAL NOT NULL CHECK (cantidad > 0),
      precio_unitario_venta REAL NOT NULL CHECK (precio_unitario_venta >= 0),
      costo_unitario_historico REAL NOT NULL DEFAULT 0,
      descuento_linea REAL NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL,
      ingreso_neto REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (id_venta) REFERENCES ventas(id_venta) ON DELETE CASCADE,
      FOREIGN KEY (id_producto) REFERENCES productos(id_producto)
    );
    CREATE TABLE IF NOT EXISTS pagos_venta (
      id_pago INTEGER PRIMARY KEY AUTOINCREMENT,
      id_venta INTEGER NOT NULL,
      metodo_pago TEXT NOT NULL CHECK (metodo_pago IN ('EFECTIVO', 'DEBITO', 'CREDITO', 'TRANSFERENCIA', 'CREDITO_INTERNO')),
      monto REAL NOT NULL CHECK (monto > 0),
      referencia_transaccion TEXT,
      fecha_pago DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id_venta) REFERENCES ventas(id_venta) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS movimientos_inventario (
      id_movimiento INTEGER PRIMARY KEY AUTOINCREMENT,
      id_producto INTEGER NOT NULL,
      id_usuario INTEGER NOT NULL,
      tipo_movimiento TEXT NOT NULL CHECK (tipo_movimiento IN (
        'ENTRADA_COMPRA', 'SALIDA_VENTA', 'DEVOLUCION_CLIENTE',
        'DEVOLUCION_PROVEEDOR', 'AJUSTE_POSITIVO', 'AJUSTE_NEGATIVO', 'MERMA'
      )),
      cantidad REAL NOT NULL CHECK (cantidad > 0),
      stock_anterior REAL NOT NULL,
      stock_resultante REAL NOT NULL,
      costo_unitario REAL,
      referencia_origen TEXT,
      motivo TEXT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id_producto) REFERENCES productos(id_producto),
      FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
    );
    CREATE TABLE IF NOT EXISTS gastos (
      id_gasto INTEGER PRIMARY KEY AUTOINCREMENT,
      categoria TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      monto REAL NOT NULL CHECK (monto > 0),
      fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS app_migrations (
      version TEXT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_productos_busqueda ON productos(nombre, sku, codigo_barras);
    CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha_venta, estado);
    CREATE INDEX IF NOT EXISTS idx_detalle_ventas_prod ON detalle_ventas(id_producto);
    CREATE INDEX IF NOT EXISTS idx_kardex_producto_fecha ON movimientos_inventario(id_producto, fecha);
    CREATE INDEX IF NOT EXISTS idx_detalle_compras_producto ON detalle_compras(id_producto);
    CREATE INDEX IF NOT EXISTS idx_pagos_venta_venta ON pagos_venta(id_venta);
    CREATE TRIGGER IF NOT EXISTS trg_actualizar_stock_kardex
    AFTER INSERT ON movimientos_inventario
    BEGIN
      UPDATE productos
      SET stock_actual = NEW.stock_resultante, actualizado_en = CURRENT_TIMESTAMP
      WHERE id_producto = NEW.id_producto;
    END;
  `;

  let localUserId = null;
  let journalMode = "memory";

  function rows(database, sql, params = []) {
    const statement = database.prepare(sql);
    try {
      statement.bind(params);
      const result = [];
      while (statement.step()) result.push(statement.getAsObject());
      return result;
    } finally {
      statement.free();
    }
  }

  function run(database, sql, params = []) {
    if (params.length) database.run(sql, params);
    else database.run(sql);
  }

  function allocateAmount(total, weights) {
    const amount = Math.max(0, Math.round(Number(total) || 0));
    const normalizedWeights = weights.map((weight) => Math.max(0, Number(weight) || 0));
    const weightTotal = normalizedWeights.reduce((sum, weight) => sum + weight, 0);
    if (!amount || !weightTotal) return normalizedWeights.map(() => 0);

    const allocations = normalizedWeights.map((weight, index) => {
      const exactAmount = amount * weight / weightTotal;
      const floorAmount = Math.floor(exactAmount);
      return { index, amount: floorAmount, remainder: exactAmount - floorAmount };
    });
    let remaining = amount - allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
    const byRemainder = [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let index = 0; remaining > 0; index += 1, remaining -= 1) {
      byRemainder[index % byRemainder.length].amount += 1;
    }
    return allocations.sort((a, b) => a.index - b.index).map((allocation) => allocation.amount);
  }

  function tableType(database, name) {
    return rows(database, "SELECT type FROM sqlite_master WHERE name = ?", [name])[0]?.type || null;
  }

  function getLegacyData(database) {
    const data = {};
    for (const name of legacyTables) {
      if (tableType(database, name) === "table") {
        data[name] = rows(database, `SELECT * FROM "${name}"`);
      }
    }
    return data;
  }

  function renameLegacyTables(database, legacyData) {
    run(database, "PRAGMA foreign_keys = OFF");
    for (const name of Object.keys(legacyData)) {
      const archivedName = `legacy_${name}`;
      if (!tableType(database, archivedName)) {
        run(database, `ALTER TABLE "${name}" RENAME TO "${archivedName}"`);
      }
    }
    run(database, "PRAGMA foreign_keys = ON");
  }

  function categoryId(database, name) {
    const category = String(name || "").trim();
    if (!category) return null;
    run(database, "INSERT INTO categorias(nombre) VALUES(?) ON CONFLICT(nombre) DO NOTHING", [category]);
    return rows(database, "SELECT id_categoria FROM categorias WHERE nombre = ?", [category])[0].id_categoria;
  }

  function migrationTables(database) {
    const existing = new Set(rows(database, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
    const legacy = {};
    for (const name of legacyTables) {
      const archivedName = `legacy_${name}`;
      if (existing.has(archivedName)) legacy[name] = rows(database, `SELECT * FROM "${archivedName}"`);
    }
    return legacy;
  }

  function migrateLegacyData(database, legacy) {
    if (!Object.keys(legacy).length || rows(database, "SELECT version FROM app_migrations WHERE version = 'legacy-v1'").length) return;
    const productRows = legacy.products || [];
    for (const product of productRows) {
      const oldId = product.id;
      const catId = categoryId(database, product.category);
      const price = Number(product.price) || 0;
      run(database, `INSERT OR IGNORE INTO productos
        (id_producto,sku,nombre,id_categoria,unidad_medida,costo_promedio,precio_neto,precio_venta_final,stock_actual,stock_minimo,actualizado_en)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [oldId, product.sku || null, product.name || "Producto migrado", catId, "UN", Number(product.cost) || 0, price, price, Number(product.stock) || 0, Number(product.min_stock) || 0, product.created_at || null]);
    }
    for (const customer of legacy.customers || []) {
      run(database, `INSERT OR IGNORE INTO clientes(id_cliente,nombre,telefono,email,direccion)
        VALUES(?,?,?,?,?)`, [customer.id, customer.name || "Cliente migrado", customer.phone || null, customer.email || null, customer.note || null]);
    }
    for (const supplier of legacy.suppliers || []) {
      run(database, `INSERT OR IGNORE INTO proveedores(id_proveedor,razon_social,telefono,email,direccion)
        VALUES(?,?,?,?,?)`, [supplier.id, supplier.name || "Proveedor migrado", supplier.phone || null, supplier.email || null, supplier.note || null]);
    }
    for (const sale of legacy.sales || []) {
      run(database, `INSERT OR IGNORE INTO ventas
        (id_venta,id_cliente,id_usuario,tipo_documento,fecha_venta,subtotal_neto,total_iva,descuento_global,total_venta,estado)
        VALUES(?,?,?,'TICKET_INTERNO',?,?,0,?,?,?)`,
      [sale.id, sale.customer_id || null, localUserId, sale.date || null, Number(sale.subtotal) || 0, Number(sale.discount) || 0, Number(sale.total) || 0, "COMPLETADA"]);
    }
    for (const item of legacy.sale_items || []) {
      const productName = item.product_name || rows(database, "SELECT nombre FROM productos WHERE id_producto=?", [item.product_id])[0]?.nombre || "Producto";
      run(database, `INSERT OR IGNORE INTO detalle_ventas
        (id_detalle_venta,id_venta,id_producto,cantidad,precio_unitario_venta,costo_unitario_historico,subtotal)
        VALUES(?,?,?,?,?,?,?)`,
      [item.id, item.sale_id, item.product_id, item.quantity, item.unit_price, 0, item.line_total ?? item.unit_price * item.quantity]);
      void productName;
    }
    const paymentTypes = {
      Efectivo: "EFECTIVO", Débito: "DEBITO", Crédito: "CREDITO",
      Transferencia: "TRANSFERENCIA", Otro: "CREDITO_INTERNO"
    };
    for (const payment of legacy.payments || []) {
      run(database, `INSERT OR IGNORE INTO pagos_venta(id_pago,id_venta,metodo_pago,monto)
        VALUES(?,?,?,?)`, [payment.id, payment.sale_id, paymentTypes[payment.type] || "CREDITO_INTERNO", payment.amount]);
    }
    const oldProducts = new Map(productRows.map((product) => [Number(product.id), Number(product.stock) || 0]));
    const oldMovements = [...(legacy.stock_movements || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.id) - Number(b.id));
    const deltas = new Map();
    for (const movement of oldMovements) {
      const delta = Number(movement.quantity) || 0;
      deltas.set(Number(movement.product_id), (deltas.get(Number(movement.product_id)) || 0) + delta);
    }
    const balances = new Map();
    for (const [productId, finalStock] of oldProducts) balances.set(productId, finalStock - (deltas.get(productId) || 0));
    const movementTypes = {
      entry: "ENTRADA_COMPRA",
      sale: "SALIDA_VENTA",
      return: "DEVOLUCION_CLIENTE",
      loss: "MERMA"
    };
    for (const movement of oldMovements) {
      const productId = Number(movement.product_id);
      const delta = Number(movement.quantity) || 0;
      const previous = balances.get(productId) || 0;
      const type = movement.type === "adjustment"
        ? delta < 0 ? "AJUSTE_NEGATIVO" : "AJUSTE_POSITIVO"
        : movementTypes[movement.type] || (delta < 0 ? "AJUSTE_NEGATIVO" : "AJUSTE_POSITIVO");
      if (delta !== 0) {
        run(database, `INSERT OR IGNORE INTO movimientos_inventario
          (id_movimiento,id_producto,id_usuario,tipo_movimiento,cantidad,stock_anterior,stock_resultante,referencia_origen,motivo,fecha)
          VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [movement.id, productId, localUserId, type, Math.abs(delta), previous, previous + delta, null, movement.note || null, movement.date || null]);
      }
      balances.set(productId, previous + delta);
    }
    for (const [productId, finalStock] of oldProducts) {
      const current = balances.get(productId) || 0;
      const delta = finalStock - current;
      if (delta !== 0) {
        run(database, `INSERT INTO movimientos_inventario
          (id_producto,id_usuario,tipo_movimiento,cantidad,stock_anterior,stock_resultante,referencia_origen,motivo)
          VALUES(?,?,?,?,?,?,?,?)`,
        [productId, localUserId, delta < 0 ? "AJUSTE_NEGATIVO" : "AJUSTE_POSITIVO", Math.abs(delta), current, finalStock, "MIGRACION", "Conciliación de stock heredado"]);
      }
    }
    for (const expense of legacy.expenses || []) {
      run(database, `INSERT OR IGNORE INTO gastos(id_gasto,categoria,descripcion,monto,fecha)
        VALUES(?,?,?,?,?)`, [expense.id, expense.category || "Otros", expense.description || "Gasto migrado", expense.amount, expense.date || null]);
    }
    run(database, "INSERT INTO app_migrations(version) VALUES('legacy-v1')");
  }

  function migrateLineNetRevenue(database) {
    if (rows(database, "SELECT version FROM app_migrations WHERE version='sale-net-revenue-v1'").length) return;
    const sales = rows(database, "SELECT id_venta,total_venta,total_iva FROM ventas");
    for (const sale of sales) {
      const items = rows(database, "SELECT id_detalle_venta,subtotal FROM detalle_ventas WHERE id_venta=? ORDER BY id_detalle_venta", [sale.id_venta]);
      const netRevenue = Math.max(0, Number(sale.total_venta) - Number(sale.total_iva));
      const allocations = allocateAmount(netRevenue, items.map((item) => item.subtotal));
      for (let index = 0; index < items.length; index += 1) {
        run(database, "UPDATE detalle_ventas SET ingreso_neto=? WHERE id_detalle_venta=?", [allocations[index], items[index].id_detalle_venta]);
      }
    }
    run(database, "INSERT INTO app_migrations(version) VALUES('sale-net-revenue-v1')");
  }

  function createCompatibilityViews(database) {
    const userId = Number(localUserId);
    run(database, "DROP VIEW IF EXISTS sale_items; DROP VIEW IF EXISTS stock_movements;");
    const views = `
      CREATE VIEW IF NOT EXISTS products AS
        SELECT p.id_producto AS id,p.nombre AS name,COALESCE(p.sku,'') AS sku,COALESCE(c.nombre,'') AS category,
          p.precio_venta_final AS price,p.costo_promedio AS cost,p.stock_actual AS stock,p.stock_minimo AS min_stock,
          p.actualizado_en AS created_at,COALESCE(p.codigo_barras,'') AS barcode,COALESCE(p.descripcion,'') AS description,
          p.unidad_medida AS unit,p.precio_neto AS net_price,p.exento_iva AS tax_exempt,p.activo AS active
        FROM productos p LEFT JOIN categorias c ON c.id_categoria=p.id_categoria;
      CREATE VIEW IF NOT EXISTS customers AS
        SELECT id_cliente AS id,nombre AS name,COALESCE(telefono,'') AS phone,COALESCE(email,'') AS email,
          COALESCE(direccion,'') AS note,COALESCE(rut_identificacion,'') AS rut,
          COALESCE(giro,'') AS business,COALESCE(direccion,'') AS address,creado_en AS created_at FROM clientes;
      CREATE VIEW IF NOT EXISTS suppliers AS
        SELECT id_proveedor AS id,razon_social AS name,COALESCE(telefono,'') AS phone,COALESCE(email,'') AS email,
          COALESCE(direccion,'') AS note,COALESCE(rut_identificacion,'') AS rut,
          COALESCE(contacto_nombre,'') AS contact,COALESCE(direccion,'') AS address FROM proveedores;
      CREATE VIEW IF NOT EXISTS sales AS
        SELECT id_venta AS id,id_cliente AS customer_id,fecha_venta AS date,
          subtotal_neto + total_iva AS subtotal,descuento_global AS discount,total_venta AS total,
          CASE estado WHEN 'COMPLETADA' THEN 'completed' WHEN 'ANULADA' THEN 'cancelled' ELSE 'pending' END AS status,
          subtotal_neto AS net_subtotal,total_iva AS tax,tipo_documento AS document_type,folio_documento AS folio
        FROM ventas;
      CREATE VIEW IF NOT EXISTS sale_items AS
        SELECT d.id_detalle_venta AS id,d.id_venta AS sale_id,d.id_producto AS product_id,p.nombre AS product_name,
          d.cantidad AS quantity,d.precio_unitario_venta AS unit_price,d.subtotal AS line_total,
          d.costo_unitario_historico AS unit_cost,d.descuento_linea AS line_discount,d.ingreso_neto AS net_revenue
        FROM detalle_ventas d JOIN productos p ON p.id_producto=d.id_producto;
      CREATE VIEW IF NOT EXISTS payments AS
        SELECT id_pago AS id,id_venta AS sale_id,
          CASE metodo_pago WHEN 'EFECTIVO' THEN 'Efectivo' WHEN 'DEBITO' THEN 'Débito'
            WHEN 'CREDITO' THEN 'Crédito' WHEN 'TRANSFERENCIA' THEN 'Transferencia' ELSE 'Otro' END AS type,
          monto AS amount,referencia_transaccion AS reference FROM pagos_venta;
      CREATE VIEW IF NOT EXISTS stock_movements AS
        SELECT m.id_movimiento AS id,m.id_producto AS product_id,
          CASE m.tipo_movimiento WHEN 'ENTRADA_COMPRA' THEN 'entry' WHEN 'SALIDA_VENTA' THEN 'sale'
            WHEN 'DEVOLUCION_CLIENTE' THEN 'return' WHEN 'DEVOLUCION_PROVEEDOR' THEN 'supplier_return'
            WHEN 'MERMA' THEN 'loss' ELSE 'adjustment' END AS type,
          CASE WHEN m.tipo_movimiento IN ('SALIDA_VENTA','DEVOLUCION_PROVEEDOR','AJUSTE_NEGATIVO','MERMA')
            THEN -m.cantidad ELSE m.cantidad END AS quantity,
          m.motivo AS note,m.fecha AS date,m.referencia_origen AS reference,m.id_usuario AS user_id,
          COALESCE(c.id_proveedor,pr.id_proveedor) AS supplier_id,
          NULL AS purchase_document,NULL AS purchase_folio,NULL AS purchase_cost,
          m.stock_anterior AS previous_stock,m.stock_resultante AS resulting_stock,m.costo_unitario AS cost
        FROM movimientos_inventario m
        LEFT JOIN compras c ON m.referencia_origen='COMPRA #' || c.id_compra
        LEFT JOIN proveedores pr ON m.referencia_origen='DEVOLUCION PROVEEDOR #' || pr.id_proveedor;
      CREATE VIEW IF NOT EXISTS expenses AS
        SELECT id_gasto AS id,categoria AS category,descripcion AS description,monto AS amount,fecha AS date FROM gastos;

      CREATE TRIGGER IF NOT EXISTS products_insert INSTEAD OF INSERT ON products BEGIN
        INSERT INTO categorias(nombre) SELECT TRIM(NEW.category) WHERE TRIM(COALESCE(NEW.category,'')) <> ''
          ON CONFLICT(nombre) DO NOTHING;
        INSERT INTO productos(sku,codigo_barras,nombre,descripcion,id_categoria,unidad_medida,costo_promedio,
          precio_neto,exento_iva,precio_venta_final,stock_actual,stock_minimo,activo,actualizado_en)
        VALUES(NULLIF(TRIM(NEW.sku),''),NULLIF(TRIM(NEW.barcode),''),NEW.name,NULLIF(NEW.description,''),
          (SELECT id_categoria FROM categorias WHERE nombre=TRIM(NEW.category)),
          COALESCE(NEW.unit,'UN'),COALESCE(NEW.cost,0),COALESCE(NEW.net_price,NEW.price,0),
          COALESCE(NEW.tax_exempt,0),COALESCE(NEW.price,0),COALESCE(NEW.stock,0),COALESCE(NEW.min_stock,0),
          COALESCE(NEW.active,1),COALESCE(NEW.created_at,CURRENT_TIMESTAMP));
      END;
      CREATE TRIGGER IF NOT EXISTS products_update INSTEAD OF UPDATE ON products BEGIN
        INSERT INTO categorias(nombre) SELECT TRIM(NEW.category) WHERE TRIM(COALESCE(NEW.category,'')) <> ''
          ON CONFLICT(nombre) DO NOTHING;
        UPDATE productos SET sku=NULLIF(TRIM(NEW.sku),''),codigo_barras=NULLIF(TRIM(NEW.barcode),''),
          nombre=NEW.name,descripcion=NULLIF(NEW.description,''),
          id_categoria=(SELECT id_categoria FROM categorias WHERE nombre=TRIM(NEW.category)),
          unidad_medida=COALESCE(NEW.unit,'UN'),costo_promedio=COALESCE(NEW.cost,0),
          precio_neto=COALESCE(NEW.net_price,NEW.price,0),exento_iva=COALESCE(NEW.tax_exempt,0),
          precio_venta_final=COALESCE(NEW.price,0),stock_actual=COALESCE(NEW.stock,0),
          stock_minimo=COALESCE(NEW.min_stock,0),activo=COALESCE(NEW.active,1),actualizado_en=CURRENT_TIMESTAMP
        WHERE id_producto=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS products_delete INSTEAD OF DELETE ON products BEGIN
        DELETE FROM productos WHERE id_producto=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS customers_insert INSTEAD OF INSERT ON customers BEGIN
        INSERT INTO clientes(rut_identificacion,nombre,giro,telefono,email,direccion)
        VALUES(NULLIF(TRIM(NEW.rut),''),NEW.name,NULLIF(NEW.business,''),NULLIF(NEW.phone,''),
          NULLIF(NEW.email,''),NULLIF(COALESCE(NEW.address,NEW.note),''));
      END;
      CREATE TRIGGER IF NOT EXISTS customers_update INSTEAD OF UPDATE ON customers BEGIN
        UPDATE clientes SET rut_identificacion=NULLIF(TRIM(NEW.rut),''),nombre=NEW.name,
          giro=NULLIF(NEW.business,''),telefono=NULLIF(NEW.phone,''),email=NULLIF(NEW.email,''),
          direccion=NULLIF(COALESCE(NEW.address,NEW.note),'') WHERE id_cliente=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS suppliers_insert INSTEAD OF INSERT ON suppliers BEGIN
        INSERT INTO proveedores(rut_identificacion,razon_social,contacto_nombre,telefono,email,direccion)
        VALUES(NULLIF(TRIM(NEW.rut),''),NEW.name,NULLIF(NEW.contact,''),NULLIF(NEW.phone,''),
          NULLIF(NEW.email,''),NULLIF(COALESCE(NEW.address,NEW.note),''));
      END;
      CREATE TRIGGER IF NOT EXISTS suppliers_update INSTEAD OF UPDATE ON suppliers BEGIN
        UPDATE proveedores SET rut_identificacion=NULLIF(TRIM(NEW.rut),''),razon_social=NEW.name,
          contacto_nombre=NULLIF(NEW.contact,''),telefono=NULLIF(NEW.phone,''),email=NULLIF(NEW.email,''),
          direccion=NULLIF(COALESCE(NEW.address,NEW.note),'') WHERE id_proveedor=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS sales_insert INSTEAD OF INSERT ON sales BEGIN
        INSERT INTO ventas(id_cliente,id_usuario,tipo_documento,folio_documento,fecha_venta,subtotal_neto,
          total_iva,descuento_global,total_venta,estado)
        VALUES(NEW.customer_id,${userId},COALESCE(NEW.document_type,'BOLETA'),NEW.folio,NEW.date,
          COALESCE(NEW.net_subtotal,NEW.subtotal,0),COALESCE(NEW.tax,0),COALESCE(NEW.discount,0),
          NEW.total,CASE NEW.status WHEN 'cancelled' THEN 'ANULADA' WHEN 'pending' THEN 'PENDIENTE' ELSE 'COMPLETADA' END);
      END;
      CREATE TRIGGER IF NOT EXISTS sales_update INSTEAD OF UPDATE ON sales BEGIN
        UPDATE ventas SET id_cliente=NEW.customer_id,tipo_documento=COALESCE(NEW.document_type,'BOLETA'),
          folio_documento=NEW.folio,fecha_venta=COALESCE(NEW.date,fecha_venta),
          subtotal_neto=COALESCE(NEW.net_subtotal,NEW.subtotal,0),total_iva=COALESCE(NEW.tax,0),
          descuento_global=COALESCE(NEW.discount,0),total_venta=NEW.total,
          estado=CASE NEW.status WHEN 'cancelled' THEN 'ANULADA' WHEN 'pending' THEN 'PENDIENTE' ELSE 'COMPLETADA' END
        WHERE id_venta=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS sales_delete INSTEAD OF DELETE ON sales BEGIN
        DELETE FROM ventas WHERE id_venta=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS sale_items_insert INSTEAD OF INSERT ON sale_items BEGIN
        INSERT INTO detalle_ventas(id_venta,id_producto,cantidad,precio_unitario_venta,
          costo_unitario_historico,descuento_linea,subtotal,ingreso_neto)
        VALUES(NEW.sale_id,NEW.product_id,NEW.quantity,NEW.unit_price,COALESCE(NEW.unit_cost,0),
          COALESCE(NEW.line_discount,0),NEW.line_total,COALESCE(NEW.net_revenue,0));
      END;
      CREATE TRIGGER IF NOT EXISTS sale_items_delete INSTEAD OF DELETE ON sale_items BEGIN
        DELETE FROM detalle_ventas WHERE id_detalle_venta=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS payments_insert INSTEAD OF INSERT ON payments BEGIN
        INSERT INTO pagos_venta(id_venta,metodo_pago,monto,referencia_transaccion)
        VALUES(NEW.sale_id,CASE NEW.type WHEN 'Efectivo' THEN 'EFECTIVO' WHEN 'Débito' THEN 'DEBITO'
          WHEN 'Crédito' THEN 'CREDITO' WHEN 'Transferencia' THEN 'TRANSFERENCIA' ELSE 'CREDITO_INTERNO' END,
          NEW.amount,NEW.reference);
      END;
      CREATE TRIGGER IF NOT EXISTS payments_delete INSTEAD OF DELETE ON payments BEGIN
        DELETE FROM pagos_venta WHERE id_pago=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS stock_movements_insert INSTEAD OF INSERT ON stock_movements BEGIN
        INSERT INTO compras(id_proveedor,id_usuario,tipo_documento,folio_documento,total_neto,total_iva,total_compra)
        SELECT NEW.supplier_id,${userId},COALESCE(NEW.purchase_document,'SIN_DOC'),NEW.purchase_folio,
          ABS(NEW.quantity)*COALESCE(NEW.purchase_cost,p.costo_promedio,0),0,
          ABS(NEW.quantity)*COALESCE(NEW.purchase_cost,p.costo_promedio,0)
        FROM productos p
        WHERE p.id_producto=NEW.product_id AND NEW.type='entry' AND NEW.supplier_id IS NOT NULL;
        INSERT INTO detalle_compras(id_compra,id_producto,cantidad,costo_unitario_neto,subtotal_neto)
        SELECT last_insert_rowid(),NEW.product_id,ABS(NEW.quantity),COALESCE(NEW.purchase_cost,p.costo_promedio,0),
          ABS(NEW.quantity)*COALESCE(NEW.purchase_cost,p.costo_promedio,0)
        FROM productos p
        WHERE p.id_producto=NEW.product_id AND NEW.type='entry' AND NEW.supplier_id IS NOT NULL;
        UPDATE productos SET costo_promedio=
          CASE WHEN stock_actual<=0 THEN COALESCE(NEW.purchase_cost,costo_promedio)
            ELSE ((stock_actual*costo_promedio)+(ABS(NEW.quantity)*COALESCE(NEW.purchase_cost,costo_promedio)))
              /(stock_actual+ABS(NEW.quantity)) END
        WHERE id_producto=NEW.product_id AND NEW.type='entry';
        INSERT INTO movimientos_inventario(id_producto,id_usuario,tipo_movimiento,cantidad,stock_anterior,
          stock_resultante,costo_unitario,referencia_origen,motivo,fecha)
        SELECT NEW.product_id,${userId},
          CASE NEW.type WHEN 'entry' THEN 'ENTRADA_COMPRA' WHEN 'sale' THEN 'SALIDA_VENTA'
            WHEN 'return' THEN 'DEVOLUCION_CLIENTE' WHEN 'supplier_return' THEN 'DEVOLUCION_PROVEEDOR'
            WHEN 'loss' THEN 'MERMA' WHEN 'adjustment' THEN
              CASE WHEN NEW.quantity < 0 THEN 'AJUSTE_NEGATIVO' ELSE 'AJUSTE_POSITIVO' END
            ELSE RAISE(ABORT,'Tipo de movimiento no válido') END,
          ABS(NEW.quantity),p.stock_actual,p.stock_actual+NEW.quantity,
          COALESCE(NEW.cost,p.costo_promedio),
          CASE WHEN NEW.type='entry' AND NEW.supplier_id IS NOT NULL
            THEN 'COMPRA #' || (SELECT MAX(id_compra) FROM compras)
            WHEN NEW.type='supplier_return' AND NEW.supplier_id IS NOT NULL
            THEN 'DEVOLUCION PROVEEDOR #' || NEW.supplier_id ELSE NEW.reference END,NEW.note,
          COALESCE(NEW.date,CURRENT_TIMESTAMP)
        FROM productos p WHERE p.id_producto=NEW.product_id;
      END;
      CREATE TRIGGER IF NOT EXISTS expenses_insert INSTEAD OF INSERT ON expenses BEGIN
        INSERT INTO gastos(categoria,descripcion,monto,fecha)
        VALUES(NEW.category,NEW.description,NEW.amount,COALESCE(NEW.date,CURRENT_TIMESTAMP));
      END;
    `;
    run(database, views);
  }

  async function ensureLocalUser(database) {
    const existing = rows(database, `SELECT id_usuario FROM usuarios WHERE activo=1
      ORDER BY CASE rol WHEN 'ADMIN' THEN 0 ELSE 1 END,id_usuario LIMIT 1`)[0];
    if (existing) {
      localUserId = existing.id_usuario;
      return;
    }
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", secret));
    const passwordHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    run(database, `INSERT INTO usuarios(nombre,email,password_hash,rol)
      VALUES('Cuenta local del dispositivo','local@cuentaclara.invalid',?,'ADMIN')
      ON CONFLICT(email) DO UPDATE SET activo=1`,
    [passwordHash]);
    localUserId = rows(database, "SELECT id_usuario FROM usuarios WHERE email='local@cuentaclara.invalid'")[0].id_usuario;
  }

  async function initialize(database) {
    run(database, "PRAGMA foreign_keys = ON");
    journalMode = rows(database, "PRAGMA journal_mode = WAL")[0]?.journal_mode || "delete";
    let legacy = getLegacyData(database);
    if (Object.keys(legacy).length) renameLegacyTables(database, legacy);
    run(database, schema);
    const detailColumns = rows(database, "PRAGMA table_info(detalle_ventas)");
    if (!detailColumns.some((column) => column.name === "ingreso_neto")) {
      run(database, "ALTER TABLE detalle_ventas ADD COLUMN ingreso_neto REAL NOT NULL DEFAULT 0");
    }
    await ensureLocalUser(database);
    legacy = migrationTables(database);
    if (Object.keys(legacy).length) {
      run(database, "BEGIN TRANSACTION");
      try {
        migrateLegacyData(database, legacy);
        run(database, "COMMIT");
      } catch (error) {
        run(database, "ROLLBACK");
        throw error;
      }
    }
    run(database, "BEGIN TRANSACTION");
    try {
      migrateLineNetRevenue(database);
      run(database, "COMMIT");
    } catch (error) {
      run(database, "ROLLBACK");
      throw error;
    }
    createCompatibilityViews(database);
    const missingTables = [
      "usuarios", "categorias", "proveedores", "clientes", "productos", "compras",
      "detalle_compras", "ventas", "detalle_ventas", "pagos_venta", "movimientos_inventario"
    ].filter((table) => tableType(database, table) !== "table");
    if (missingTables.length) throw new Error(`No se pudo inicializar el esquema: ${missingTables.join(", ")}.`);
    const violations = rows(database, "PRAGMA foreign_key_check");
    if (violations.length) throw new Error("La base de datos contiene referencias inválidas. Se detuvo la apertura para proteger sus datos.");
    return { userId: localUserId, journalMode };
  }

  window.DatabaseLayer = { allocateAmount, initialize };
})();
