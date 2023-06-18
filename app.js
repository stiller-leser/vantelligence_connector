import process from 'node:process'
import { createServer } from 'http'
import chalk from 'chalk'
import mqtt from 'mqtt'
import fs from 'fs'

const BASE_TOPIC = 'connector'
const DEVICE_TOPIC = 'device'
const CONFIG_TOPIC = 'config'
const DEVICE_PATH = './device/'
const DEVICE_CLASSES = {}
const DEVICE_INSTANCES = []
const HA_BASE_TOPIC = 'homeassistant'
const CONFIG_FILE = './config.json'

let HA_DISCOVERY = []
let SUBSCRIBED_TOPICS = {}
let PUBLISH_TOPICS = []

// get device class list
fs.readdir(DEVICE_PATH, async (error, files) => {
  if (error) {
    log('⚠️', error)
  } else {
    for (let file of files) {
      try {
        // import device 
        const module = await import(DEVICE_PATH + file)
        

        // development filter
        if (['Socketcan.js', 'Bluetooth.js'].includes(file)) continue
        //if (!['Pigpio.js'].includes(file)) continue

        // build devie class object
        DEVICE_CLASSES[String(file).slice(0, file.lastIndexOf('.'))] = module.default

        log('✨', 'Device class found: ' + file)
      } catch (error) {
        log(error)
      }
      
    }

    connect()
  }
})

function connect () {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.split('=')))

  const host = args.host || process.env.MQTT_HOST || 'localhost'
  const options = {
    port: args.port || process.env.MQTT_PORT || 1883,
    username: args.username || process.env.MQTT_USERNAME,
    password: args.password || process.env.MQTT_PASSWORD
  }

  // create client
  const client = mqtt.connect('mqtt://' + host, options)
  
  // connect to broker
  client.on('connect', () => {
    // check if local config exists
    if (fs.existsSync(CONFIG_FILE)) {
      log('✨', 'Local config found. Publishing...')

      client.publish(BASE_TOPIC + '/' + CONFIG_TOPIC, fs.readFileSync(CONFIG_FILE), { retain: true })
    }

    // subscribe to config topic
    client.subscribe(BASE_TOPIC + '/' + CONFIG_TOPIC)
  })

  // error handling
  client.on('error', error => {
    log('⚠️', 'Error connecting mqtt at "' + chalk.cyan(host + ':' + options.port) + '": ' + chalk.red(error.code))
  })

  // react to messages of subscribed topics
  client.on('message', (topic, message) => {
    const parts = topic.split('/')

    if (parts[0] === BASE_TOPIC) {
      if (parts[1] === CONFIG_TOPIC) {
        log('✨', 'New config discovered. Processing...')

        processConfig(client, JSON.parse(message))
      } else if (SUBSCRIBED_TOPICS[topic] instanceof Object) {
        Object.keys(SUBSCRIBED_TOPICS[topic]).forEach(key => SUBSCRIBED_TOPICS[topic][key](parts[parts.length - 1], message.toString()))
      }
    } else if (parts[0] === HA_BASE_TOPIC) {
      if (parts[1] === 'status' && parts.length === 2 && message.toString() === 'online') {
        HA_DISCOVERY = []
      }
    }
  })
}

async function processConfig (client, data) {
  if (data.support.includes('homeassistant')) {
    client.subscribe(HA_BASE_TOPIC + '/status')
  }

  Object.values(DEVICE_INSTANCES).forEach(device => {
    device.disconnect()
  })

  client.unsubscribe(Object.keys(SUBSCRIBED_TOPICS))

  SUBSCRIBED_TOPICS = {}
  PUBLISH_TOPICS = []

  for (let config of data.devices) {
    const deviceClass = DEVICE_CLASSES[config.class]

    if (deviceClass) {
      const device = new deviceClass(config)

      device.onEntityUpdate(entity => processEntity(client, device, entity, data.support))
      device.onMessage((icon, message) => log(icon, message, device))

      const result = await device.connect()
      const message = 'connects by ' + chalk.yellow(device.manufacturer + ' ' + device.model) + ': '

      if (typeof result === 'string') {
        log('⚡', message + chalk.black.bgRed(' FAIL ') + ' ' + result, device)
      } else {
        log('⚡', message + chalk.black.bgGreen(' SUCCESS '), device)
        
        if (config.subscribe instanceof Object) {
          Object.entries(config.subscribe).forEach(([key, topic]) => subscribe(client, topic, device, key))
        }

        DEVICE_INSTANCES[device.id] = device
      }
    } else {
      log('⚠️', 'Unknown device class in config: ' + config.class)
    }
  }
}

function processEntity (client, device, entity, support) {
  publish(client, device, entity, support)

  if (entity.commands instanceof Array) {
    entity.commands.forEach(command => subscribe(client, getEntityTopic(device, entity) + '/' + command, device, entity.key))
  }
}

function publish (client, device, entity, support) {
  const topic = getEntityTopic(device, entity)

  if (!PUBLISH_TOPICS.includes(topic)) {
    log('📣', 'published entity "' + chalk.cyan(entity.name) + '" to topic "' + chalk.yellow(topic) + '"', device)

    client.publish(topic, JSON.stringify(entity), { retain: true })

    PUBLISH_TOPICS.push(topic)
  }

  if (entity.states instanceof Object) {
    Object.entries(entity.states).forEach(([key, state]) => {
      client.publish(getEntityTopic(device, entity) + '/' + key, String(state), { retain: true })
    })
  }

  if (support.includes('homeassistant') && !HA_DISCOVERY.includes(topic)) {
    publishHomeAssistantDiscovery(client, device, entity, topic)
  }
}

function subscribe (client, topic, device, key) {
  if (typeof SUBSCRIBED_TOPICS[topic] !== 'object') {
    SUBSCRIBED_TOPICS[topic] = {}
  }

  if (typeof SUBSCRIBED_TOPICS[topic][device.id] === 'function') {
    return false
  }

  SUBSCRIBED_TOPICS[topic][device.id] = (state, value) => device.handle(key, state, value)

  client.subscribe(topic)

  log('📡', 'subscribed to topic "' + chalk.yellow(topic) + '"', device)

  return true
}

function getEntityTopic (device, entity) {
  return [BASE_TOPIC, DEVICE_TOPIC, device.id, (entity.key ? entity.key : entity)].join('/')
}

function publishHomeAssistantDiscovery (client, device, entity, topic) {
  HA_DISCOVERY.push(topic)

  const id = device.id + '_' + entity.key
  const type = entity.type || 'sensor'
  const config = {
    name: device.name + ' ' + entity.name,
    unique_id: id,
    device: {
      name: device.name,
      model: device.model,
      manufacturer: device.manufacturer,
      sw_version: device.version,
      identifiers: [ device.id ]
    }
  }

  if (entity.states instanceof Object) {
    Object.keys(entity.states).forEach(state => {
      config[state + '_topic'] = getEntityTopic(device, entity) + '/' + state
    })
  }

  if (entity.commands instanceof Array) {
    entity.commands.forEach(command => {
      config[command + '_topic'] = getEntityTopic(device, entity) + '/' + command
    })
  }

  if (type === 'sensor') {
    config.device_class = entity.class
    config.unit_of_measurement = entity.unit
  }
  
  if (type === 'select') {
    if (entity.options instanceof Object) {
      config.options = Object.values(entity.options)
      config.command_template = Object.entries(entity.options).map(([key, value]) => '{% if value == "' + value + '" %} ' + key + ' {% endif %}').join('')
    }
  }
  
  if (type === 'climate') {
    config.min_temp = entity.minTemp
    config.max_temp = entity.maxTemp
    config.temp_step = entity.tempStep
    config.modes = entity.modes,
    config.fan_modes = entity.fanModes
    config.payload_available = 'online'
    config.payload_not_available = 'offline'
    config.availability_topic = topic + '/state'
  }
  
  if (type === 'number') {
    config.min = entity.min
    config.max = entity.max
    config.step = entity.step
  }
  
  if (type === 'light') {
    config.brightness_scale = entity.brightnessScale
    config.schema = 'json'
    config.brightness = entity.brightness
  }

  client.publish([HA_BASE_TOPIC, type, id, 'config'].join('/'), JSON.stringify(config), { retain: true })
}

function log (icon, message, device) {
  const content = (icon ? icon + '  ' : '') + (device ? chalk.black.bgCyan(' ' + device.name + ' ') + ' ' : '') + message

  console.log(content)

  fs.writeFile('./debug.log', content + '\n', { flag: 'a+' }, err => {
    if (err) {
      console.error(err);
    }
  })
}

process.on('unhandledRejection', (reason, promise) => {
  log('💥', 'Unhandled Rejection at:' + promise + 'reason:', reason)
})