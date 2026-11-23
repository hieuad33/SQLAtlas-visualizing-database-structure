import { createProject } from './model'
import { parseSql } from './sql'

export const demoSql = `CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE categories (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(120) NOT NULL UNIQUE
);

CREATE TABLE products (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  category_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(150) NOT NULL,
  price DECIMAL(12, 2) NOT NULL,
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE addresses (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  city VARCHAR(100) NOT NULL,
  postal_code VARCHAR(16),
  CONSTRAINT fk_addresses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE orders (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  total_amount DECIMAL(12, 2) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE payments (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  paid_at DATETIME,
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE order_items (
  order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  unit_price DECIMAL(12, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE audit_logs (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  event VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);`

export function demoProject() {
  const project = createProject('commerce_core', parseSql(demoSql))
  const positions: Record<string, { x: number; y: number }> = {
    users: { x: 0, y: 2 }, addresses: { x: 0, y: 236 }, audit_logs: { x: 0, y: 458 },
    orders: { x: 320, y: 113 }, payments: { x: 320, y: 378 }, order_items: { x: 640, y: 425 },
    categories: { x: 640, y: -26 }, products: { x: 640, y: 177 },
  }
  project.positions = Object.fromEntries(project.model.tables.map(table => [table.id, positions[table.name]]))
  project.view.selected = project.model.tables.find(table => table.name === 'orders')!.id
  project.notes = [{ id: 'demo-note', table: null, text: 'Đơn hàng liên kết khách hàng, thanh toán và các sản phẩm đã mua.', position: { x: 320, y: 558 } }]
  return project
}
