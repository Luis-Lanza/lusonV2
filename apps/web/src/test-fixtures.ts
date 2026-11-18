// Isolated component/parser tests only. Production never imports this module.
// The inventory wire is the variant identity of its kind plus its three stock
// numbers, so a battery row carries its battery attributes and no typed field.
export const rowJSON = '{"variant_id":1,"catalog_entry_id":1,"kind":"battery","name":"TOYO · A_%\\\\","detail":"6.5 Ah · L","battery":{"brand":"TOYO","model":"A_%\\\\","capacity_ah":"6.5","polarity":"L"},"fields":null,"existing":9007199254740993,"reserved":1,"available":9007199254740992}';
export const pageJSON = (items = rowJSON, page = 1, total = 190) => `{"location":{"id":1,"name":"Almacén"},"items":[${items}],"page":${page},"page_size":10,"total_variants":${total}}`;
