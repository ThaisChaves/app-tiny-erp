const { firestore } = require('firebase-admin')
const ecomClient = require('@ecomplus/client')
const getAppData = require('../store-api/get-app-data')
const updateAppData = require('../store-api/update-app-data')
const Tiny = require('../tiny/constructor')
const parseProduct = require('./parsers/product-to-ecomplus')
const handleJob = require('./handle-job')

module.exports = ({ appSdk, storeId, auth }, tinyToken, queueEntry, appData, canCreateNew, isHiddenQueue) => {
  const [sku, productId] = String(queueEntry.nextId).split(';:')

  return firestore().collection('tiny_stock_updates')
    .where('ref', '==', `${storeId}_${tinyToken}_${sku}`)
    .limit(10)
    .get().then(querySnapshot => {
      let tinyStockUpdate
      querySnapshot.forEach(documentSnapshot => {
        tinyStockUpdate = documentSnapshot.data()
        documentSnapshot.ref.delete().catch(console.error)
      })
      return tinyStockUpdate
    })

    .then(tinyStockUpdate => {
      return productId
        ? ecomClient.store({
          url: `/products/${productId}.json`
        }).catch(err => {
          if (err.response && err.response.status === 404) {
            return null
          }
          throw err
        })

        : ecomClient.search({
          url: '/items.json',
          data: {
            query: {
              bool: {
                should: [{
                  term: { sku }
                }, {
                  nested: {
                    path: 'variations',
                    query: {
                      bool: {
                        filter: [{
                          term: { 'variations.sku': sku }
                        }]
                      }
                    }
                  }
                }]
              }
            }
          }
        }).then(({ data }) => {
          const hit = Array.isArray(data.hits.hits) && data.hits.hits[0] && data.hits.hits[0]
          if (hit) {
            const { _id, _source } = hit
            if (_source.variations && _source.variations.length) {
              return ecomClient.store({ url: `/products/${_id}.json` })
                .then(({ data }) => data)
            }
            return {
              _id,
              ..._source
            }
          }
          return null
        })

          .then(product => {
            if (product && product.variations && product.variations.length) {
              const variation = product.variations.find(variation => sku === variation.sku)
              if (variation) {
                return {
                  product,
                  variationId: variation._id
                }
              } else {
                const msg = sku +
                  ' corresponde a um produto com variações, especifique o SKU da variação para importar.'
                const err = new Error(msg)
                err.isConfigError = true
                handleJob({ appSdk, storeId }, queueEntry, Promise.reject(err))
                return null
              }
            }
            return { product }
          })

          .then(payload => {
            if (!payload) {
              return payload
            }
            const { product, variationId } = payload
            const tiny = new Tiny(tinyToken)

            if (tinyStockUpdate && !product && isHiddenQueue) {
              handleJob({ appSdk, storeId }, queueEntry, Promise.resolve(null))
              return
            }

            const handleTinyStock = ({ produto }, tinyProduct) => {
              const quantity = Number(produto.saldo)
              if (product && !appData.update_product) {
                if (!isNaN(quantity)) {
                  let endpoint = `/products/${product._id}`
                  if (variationId) {
                    endpoint += `/variations/${variationId}`
                  }
                  endpoint += '/quantity.json'
                  console.log(endpoint, { quantity })
                  return appSdk.apiRequest(storeId, endpoint, 'PUT', { quantity }, auth)
                }
                return null
              }

              return tiny.post('/produto.obter.php', { id: tinyProduct.id })
                .then(({ produto }) => {
                  let method, endpoint
                  if (product && product._id) {
                    method = 'PATCH'
                    endpoint = `/products/${product._id}.json`
                  } else {
                    method = 'POST'
                    endpoint = '/products.json'
                  }
                  return parseProduct(produto, storeId, auth, method === 'POST').then(product => {
                    product.quantity = quantity
                    const promise = appSdk.apiRequest(storeId, endpoint, method, product, auth)

                    if (Array.isArray(produto.variacoes) && produto.variacoes.length) {
                      promise.then(() => {
                        return getAppData({ appSdk, storeId, auth })
                          .then(appData => {
                            let skus = appData.importation && appData.importation.__Skus
                            if (!Array.isArray(skus)) {
                              skus = []
                            }
                            let isQueuedVariations = false
                            produto.variacoes.forEach(({ variacao }) => {
                              const { codigo } = variacao
                              const skuAndId = `${codigo};:${product._id}`
                              if (!skus.includes(codigo) && !skus.includes(skuAndId)) {
                                isQueuedVariations = true
                                skus.push(skuAndId)
                              }
                            })
                            return isQueuedVariations
                              ? updateAppData({ appSdk, storeId, auth }, {
                                importation: {
                                  __Skus: skus
                                }
                              })
                              : true
                          })
                      }).catch(console.error)
                    }

                    return promise
                  })
                })
            }

            let job
            if (tinyStockUpdate && isHiddenQueue) {
              job = handleTinyStock(tinyStockUpdate)
            } else {
              job = tiny.post('/produtos.pesquisa.php', { pesquisa: sku })
                .then(({ produtos }) => {
                  if (Array.isArray(produtos)) {
                    let tinyProduct = produtos.find(({ produto }) => sku === String(produto.codigo))
                    if (tinyProduct) {
                      tinyProduct = tinyProduct.produto
                      if (tinyStockUpdate) {
                        return handleTinyStock(tinyStockUpdate, tinyProduct)
                      }
                      return tiny.post('/produto.obter.estoque.php', { id: tinyProduct.id })
                        .then(tinyStock => handleTinyStock(tinyStock, tinyProduct))
                    }
                  }

                  const msg = `SKU ${sku} não encontrado no Tiny`
                  const err = new Error(msg)
                  err.isConfigError = true
                  throw new Error(err)
                })
            }

            handleJob({ appSdk, storeId }, queueEntry, job)
          })
    })
}
