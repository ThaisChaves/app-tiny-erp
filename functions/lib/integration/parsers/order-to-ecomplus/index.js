module.exports = (tinyOrder, shippingLines, tiny) => new Promise((resolve, reject) => {
  const partialOrder = {}
  if (tinyOrder.obs_interna) {
    partialOrder.staff_notes = tinyOrder.obs_interna
  }

  if (shippingLines && shippingLines.length) {
    const shippingLine = shippingLines[0]
    if (
      (tinyOrder.codigo_rastreamento || tinyOrder.url_rastreamento) &&
      (!shippingLine.tracking_codes || !shippingLine.tracking_codes.length)
    ) {
      const tracking = {
        code: tinyOrder.codigo_rastreamento || ''
      }
      if (tinyOrder.url_rastreamento) {
        tracking.link = tinyOrder.url_rastreamento
      }
      shippingLine.tracking_codes = [tracking]
      partialOrder.shipping_lines = shippingLines
    }

    if (tinyOrder.id_nota_fiscal > 0) {
      shippingLine.invoices = []
      return tiny.post('/nota.fiscal.obter.php', { id: tinyOrder.id_nota_fiscal })
        .then(tinyInvoice => {
          const number = String(tinyInvoice.nota_fiscal.numero)
          if (number && !shippingLine.invoices.find(invoice => invoice.number === number)) {
            shippingLine.invoices.push({
              number,
              serial_number: String(tinyInvoice.nota_fiscal.serie)
            })
          }
          partialOrder.shipping_lines = shippingLines
          resolve(partialOrder)
        })
        .catch(reject)
    }
  }

  resolve(partialOrder)
})
