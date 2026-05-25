-- ============================================================
-- 069 — Kitchen Stations (módulo Estaciones de Despacho)
-- Permite definir N estaciones (cocinas, bares, cafeterías),
-- agrupar categorías de menú por estación, y asignar zonas
-- del salón a cada estación para ruteo geográfico.
-- Genera token por estación para link compartible.
-- Registra auditoría de qué estación atendió cada ítem.
-- ============================================================

-- ── 1. Tabla principal de estaciones ─────────────────────────
CREATE TABLE IF NOT EXISTS kitchen_stations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'cocina'
                  CHECK (type IN ('cocina','parrilla','bar','cafeteria','postres','custom')),
  color           TEXT DEFAULT '#fb923c',
  icon            TEXT DEFAULT '🍳',
  access_token    TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(12),'hex'),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kitchen_stations_restaurant ON kitchen_stations(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_kitchen_stations_token      ON kitchen_stations(access_token);

-- ── 2. Categorías asignadas a cada estación ──────────────────
CREATE TABLE IF NOT EXISTS kitchen_station_categories (
  station_id   UUID NOT NULL REFERENCES kitchen_stations(id) ON DELETE CASCADE,
  category_id  UUID NOT NULL REFERENCES menu_categories(id)  ON DELETE CASCADE,
  PRIMARY KEY (station_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_ksc_category ON kitchen_station_categories(category_id);

-- ── 3. Zonas del salón asignadas a cada estación ─────────────
-- Una zona vacía '*' = todas las zonas (comodín). Si no hay zonas
-- registradas, la estación recibe de todas las mesas.
CREATE TABLE IF NOT EXISTS kitchen_station_zonas (
  station_id   UUID NOT NULL REFERENCES kitchen_stations(id) ON DELETE CASCADE,
  zona         TEXT NOT NULL,
  PRIMARY KEY (station_id, zona)
);

CREATE INDEX IF NOT EXISTS idx_ksz_zona ON kitchen_station_zonas(zona);

-- ── 4. Log de auditoría: qué estación atendió cada ítem ──────
CREATE TABLE IF NOT EXISTS order_item_station_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id  UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  station_id     UUID REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  station_name   TEXT,
  action         TEXT NOT NULL CHECK (action IN ('received','cooking','ready','delivered')),
  user_id        UUID,
  user_name      TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oisl_item       ON order_item_station_log(order_item_id);
CREATE INDEX IF NOT EXISTS idx_oisl_station    ON order_item_station_log(station_id);
CREATE INDEX IF NOT EXISTS idx_oisl_created    ON order_item_station_log(created_at DESC);

-- ── 5. RLS ───────────────────────────────────────────────────
ALTER TABLE kitchen_stations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_station_categories    ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_station_zonas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_station_log        ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='kitchen_stations' AND policyname='ks_all') THEN
    EXECUTE 'CREATE POLICY "ks_all" ON kitchen_stations FOR ALL USING (true) WITH CHECK (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='kitchen_station_categories' AND policyname='ksc_all') THEN
    EXECUTE 'CREATE POLICY "ksc_all" ON kitchen_station_categories FOR ALL USING (true) WITH CHECK (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='kitchen_station_zonas' AND policyname='ksz_all') THEN
    EXECUTE 'CREATE POLICY "ksz_all" ON kitchen_station_zonas FOR ALL USING (true) WITH CHECK (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='order_item_station_log' AND policyname='oisl_all') THEN
    EXECUTE 'CREATE POLICY "oisl_all" ON order_item_station_log FOR ALL USING (true) WITH CHECK (true)';
  END IF;
END$$;

GRANT ALL ON kitchen_stations           TO anon, authenticated;
GRANT ALL ON kitchen_station_categories TO anon, authenticated;
GRANT ALL ON kitchen_station_zonas      TO anon, authenticated;
GRANT ALL ON order_item_station_log     TO anon, authenticated;

-- ── 6. Realtime ──────────────────────────────────────────────
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE kitchen_stations;
EXCEPTION WHEN others THEN NULL;
END$$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE kitchen_station_categories;
EXCEPTION WHEN others THEN NULL;
END$$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE kitchen_station_zonas;
EXCEPTION WHEN others THEN NULL;
END$$;

-- ── 7. Trigger updated_at ────────────────────────────────────
CREATE OR REPLACE FUNCTION _touch_kitchen_stations()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_kitchen_stations ON kitchen_stations;
CREATE TRIGGER trg_touch_kitchen_stations
  BEFORE UPDATE ON kitchen_stations
  FOR EACH ROW EXECUTE FUNCTION _touch_kitchen_stations();

-- ── 8. Seed: 5 estaciones default a partir de tipos hardcoded ─
DO $$
DECLARE
  v_rid UUID := '00000000-0000-0000-0000-000000000001';
  v_cocina_id    UUID;
  v_parrilla_id  UUID;
  v_bar_id       UUID;
  v_cafe_id      UUID;
  v_postres_id   UUID;
BEGIN
  -- Solo seed si no hay estaciones aún
  IF EXISTS (SELECT 1 FROM kitchen_stations WHERE restaurant_id = v_rid) THEN
    RETURN;
  END IF;

  INSERT INTO kitchen_stations (restaurant_id, name, type, color, icon, sort_order)
  VALUES (v_rid, 'Cocina Caliente', 'cocina', '#fb923c', '🍳', 1)
  RETURNING id INTO v_cocina_id;

  INSERT INTO kitchen_stations (restaurant_id, name, type, color, icon, sort_order)
  VALUES (v_rid, 'Parrilla', 'parrilla', '#f87171', '🔥', 2)
  RETURNING id INTO v_parrilla_id;

  INSERT INTO kitchen_stations (restaurant_id, name, type, color, icon, sort_order)
  VALUES (v_rid, 'Bar Principal', 'bar', '#60a5fa', '🍸', 3)
  RETURNING id INTO v_bar_id;

  INSERT INTO kitchen_stations (restaurant_id, name, type, color, icon, sort_order)
  VALUES (v_rid, 'Cafeter' || chr(237) || 'a', 'cafeteria', '#c084fc', '☕', 4)
  RETURNING id INTO v_cafe_id;

  INSERT INTO kitchen_stations (restaurant_id, name, type, color, icon, sort_order)
  VALUES (v_rid, 'Postres', 'postres', '#f9a8d4', '🍰', 5)
  RETURNING id INTO v_postres_id;

  -- Asignar todas las categorías a Cocina Caliente por default (admin reconfigura después)
  INSERT INTO kitchen_station_categories (station_id, category_id)
  SELECT v_cocina_id, id FROM menu_categories WHERE restaurant_id = v_rid
  ON CONFLICT DO NOTHING;

  -- Bar recibe categorías con kitchen_station='bar' si existe ese campo
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='menu_categories' AND column_name='kitchen_station'
  ) THEN
    EXECUTE format(
      'INSERT INTO kitchen_station_categories (station_id, category_id)
       SELECT %L::uuid, id FROM menu_categories
        WHERE restaurant_id = %L::uuid AND kitchen_station = ''bar''
       ON CONFLICT DO NOTHING',
      v_bar_id, v_rid
    );
  END IF;

  -- Todas las estaciones reciben de todas las zonas por default (comodín '*')
  INSERT INTO kitchen_station_zonas (station_id, zona) VALUES
    (v_cocina_id,   '*'),
    (v_parrilla_id, '*'),
    (v_bar_id,      '*'),
    (v_cafe_id,     '*'),
    (v_postres_id,  '*')
  ON CONFLICT DO NOTHING;
END$$;

-- ── 9. View de estadísticas por estación ─────────────────────
CREATE OR REPLACE VIEW kitchen_station_stats AS
SELECT
  ks.id                                                          AS station_id,
  ks.name                                                        AS station_name,
  ks.restaurant_id,
  COUNT(DISTINCT l.order_item_id) FILTER (WHERE l.action='cooking')   AS items_cooking_total,
  COUNT(DISTINCT l.order_item_id) FILTER (WHERE l.action='ready')     AS items_ready_total,
  COUNT(DISTINCT l.order_item_id) FILTER (WHERE l.action='delivered') AS items_delivered_total,
  COUNT(DISTINCT l.order_item_id) FILTER (
    WHERE l.action='ready' AND l.created_at >= CURRENT_DATE
  ) AS items_ready_today,
  COUNT(DISTINCT l.order_item_id) FILTER (
    WHERE l.action='ready' AND l.created_at >= NOW() - INTERVAL '7 days'
  ) AS items_ready_week
FROM kitchen_stations ks
LEFT JOIN order_item_station_log l ON l.station_id = ks.id
GROUP BY ks.id, ks.name, ks.restaurant_id;

GRANT SELECT ON kitchen_station_stats TO anon, authenticated;
