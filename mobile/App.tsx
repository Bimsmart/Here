import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Animated, KeyboardAvoidingView, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { Image as ExpoImage } from 'expo-image'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import * as Crypto from 'expo-crypto'
import * as Location from 'expo-location'
import MapView, { Marker, type Region } from 'react-native-maps'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './src/lib/supabase'

type Journey = { id: string; owner_user_id: string; destination_label: string; eta: string; status: string; contact_name: string }
type PlaceSuggestion = { label: string; latitude: number; longitude: number }
type Incident = { id: string; title: string; description: string; category: string; latitude: number; longitude: number; received_at: string; verification_status: string }
type JourneyMessage = { id: string; journey_id: string; user_id: string; body: string; created_at: string }
type SharedLocation = { latitude: number; longitude: number; accuracy: number | null; updated_at: string }
type QuickAction = 'chat' | 'live' | 'report' | 'share'
type AppTab = 'home' | 'journeys' | 'map' | 'chat'
const incidentTypes = [
  { key: 'road_blockage', label: 'Road blocked' }, { key: 'flooding', label: 'Flooding' },
  { key: 'fire', label: 'Fire' }, { key: 'robbery_report', label: 'Robbery' },
  { key: 'assault_report', label: 'Assault' }, { key: 'civil_unrest', label: 'Unrest' },
  { key: 'infrastructure_disruption', label: 'Service disruption' }, { key: 'other', label: 'Other' },
]
const ink = '#18221f'
const muted = '#78827e'
const green = '#176b55'

export default function App() {
  const [introFinished, setIntroFinished] = useState(false)

  return <SafeAreaProvider><View style={styles.appRoot}>
    <StatusBar style="dark" />
    {introFinished
      ? <AppContent playBrandAnimation />
      : <OpeningIntro onFinish={() => setIntroFinished(true)} />}
  </View></SafeAreaProvider>
}

function OpeningIntro({ onFinish }: { onFinish: () => void }) {
  const opacity = useRef(new Animated.Value(1)).current
  const logoOpacity = useRef(new Animated.Value(0)).current
  const logoScale = useRef(new Animated.Value(0.72)).current
  const taglineOpacity = useRef(new Animated.Value(0)).current
  const finished = useRef(false)

  const finish = useCallback(() => {
    if (finished.current) return
    finished.current = true
    Animated.timing(opacity, { toValue: 0, duration: 420, useNativeDriver: true }).start(onFinish)
  }, [onFinish, opacity])

  useEffect(() => {
    Animated.parallel([
      Animated.timing(logoOpacity, { toValue: 1, duration: 320, useNativeDriver: true }),
      Animated.spring(logoScale, { toValue: 1, friction: 4, tension: 95, useNativeDriver: true }),
      Animated.timing(taglineOpacity, { toValue: 1, duration: 420, delay: 340, useNativeDriver: true }),
    ]).start()
    const fallback = setTimeout(finish, 5600)
    return () => clearTimeout(fallback)
  }, [finish, logoOpacity, logoScale, taglineOpacity])

  return <Animated.View style={[styles.intro, { opacity }]}>
    <View pointerEvents="none" style={styles.introCenter}>
      <Animated.View style={[styles.introLogo, { opacity: logoOpacity, transform: [{ scale: logoScale }] }]}>
        <ExpoImage source={require('./assets/here-opening-transparent.png')} style={StyleSheet.absoluteFill} contentFit="contain" autoplay />
      </Animated.View>
      <Animated.Text style={[styles.introTagline, { opacity: taglineOpacity }]}>stay connected to every journey</Animated.Text>
    </View>
  </Animated.View>
}

function AnimatedBrandMark({ active }: { active: boolean }) {
  const scale = useRef(new Animated.Value(0.82)).current
  const opacity = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!active) return
    const entrance = Animated.parallel([
      Animated.spring(scale, { toValue: 1, friction: 4, tension: 100, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 350, useNativeDriver: true }),
    ])
    entrance.start()
    return () => entrance.stop()
  }, [active, opacity, scale])

  return <Animated.View style={[styles.brandAnimation, { opacity, transform: [{ scale }] }]}>
    <ExpoImage source={require('./assets/here-opening-transparent.png')} style={StyleSheet.absoluteFill} contentFit="contain" autoplay={active} />
  </Animated.View>
}

function AppContent({ playBrandAnimation }: { playBrandAnimation: boolean }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [registering, setRegistering] = useState(false)
  const [busy, setBusy] = useState(false)
  const [journeys, setJourneys] = useState<Journey[]>([])
  const [activeTab, setActiveTab] = useState<AppTab>('home')
  const [quickMenuOpen, setQuickMenuOpen] = useState(false)
  const [quickAction, setQuickAction] = useState<QuickAction | null>(null)
  const [journeyMenuOpenId, setJourneyMenuOpenId] = useState<string | null>(null)
  const [form, setForm] = useState({ email: '', password: '', name: '' })
  const [showJourneyForm, setShowJourneyForm] = useState(false)
  const [journey, setJourney] = useState({ destination: '', latitude: '', longitude: '', eta: '', contact: '', contactEmail: '' })
  const [origin, setOrigin] = useState<{ latitude: number; longitude: number } | null>(null)
  const [mapRegion, setMapRegion] = useState<Region>({ latitude: 6.5244, longitude: 3.3792, latitudeDelta: 0.12, longitudeDelta: 0.12 })
  const [placeSuggestions, setPlaceSuggestions] = useState<PlaceSuggestion[]>([])
  const [searchingPlaces, setSearchingPlaces] = useState(false)
  const [routeEstimate, setRouteEstimate] = useState<{ seconds: number; meters: number } | null>(null)
  const [calculatingRoute, setCalculatingRoute] = useState(false)
  const [reportingJourneyId, setReportingJourneyId] = useState<string | null>(null)
  const [reportCategory, setReportCategory] = useState('road_blockage')
  const [reportDescription, setReportDescription] = useState('')
  const [reportBusy, setReportBusy] = useState(false)
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [incidentMapRegion, setIncidentMapRegion] = useState<Region>({ latitude: 6.5244, longitude: 3.3792, latitudeDelta: 0.2, longitudeDelta: 0.2 })
  const [incidentLoadError, setIncidentLoadError] = useState('')
  const [appUserId, setAppUserId] = useState<string | null>(null)
  const [invitingJourneyId, setInvitingJourneyId] = useState<string | null>(null)
  const [locationsByJourney, setLocationsByJourney] = useState<Record<string, SharedLocation>>({})
  const [trackingJourneyId, setTrackingJourneyId] = useState<string | null>(null)
  const [openChatJourneyId, setOpenChatJourneyId] = useState<string | null>(null)
  const [chatMessages, setChatMessages] = useState<JourneyMessage[]>([])
  const [chatDraft, setChatDraft] = useState('')
  const [sendingMessage, setSendingMessage] = useState(false)
  const scrollRef = useRef<any>(null)
  const journeyCardOffsets = useRef<Record<string, number>>({})
  const locationSubscription = useRef<Location.LocationSubscription | null>(null)

  useEffect(() => {
    if (!supabase) { setLoading(false); return }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => { if (session) { void loadAppUserId(); void linkAndLoad(); void loadIncidentReports() } else { setJourneys([]); setIncidents([]); setAppUserId(null); setLocationsByJourney({}) } }, [session?.user.id])

  useEffect(() => {
    if (!session) return
    const timer = setInterval(() => { if (journeys.some(item => ['ACTIVE', 'OVERDUE_PENDING', 'OVERDUE_NOTIFIED'].includes(item.status))) void linkAndLoad(false) }, 10000)
    return () => clearInterval(timer)
  }, [session?.user.id, journeys])

  useEffect(() => {
    if (!openChatJourneyId) { setChatMessages([]); return }
    void loadChatMessages(openChatJourneyId)
    const timer = setInterval(() => void loadChatMessages(openChatJourneyId), 4000)
    return () => clearInterval(timer)
  }, [openChatJourneyId])

  useEffect(() => () => { locationSubscription.current?.remove() }, [])

  useEffect(() => {
    const query = journey.destination.trim()
    if (query.length < 3 || journey.latitude || journey.longitude) { setPlaceSuggestions([]); setSearchingPlaces(false); return }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setSearchingPlaces(true)
      try {
        const bias = origin ? `&lat=${origin.latitude}&lon=${origin.longitude}` : ''
        const response = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5${bias}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Place search is temporarily unavailable.')
        const result = await response.json()
        const suggestions = (result.features ?? []).map((feature: any) => {
          const properties = feature.properties ?? {}
          const primary = properties.name ?? properties.street ?? 'Location'
          const details = [properties.city ?? properties.locality ?? properties.district, properties.state, properties.country]
            .filter(Boolean).filter((part: string, index: number, values: string[]) => values.indexOf(part) === index && part !== primary)
          return { label: [primary, ...details].join(', '), latitude: feature.geometry.coordinates[1], longitude: feature.geometry.coordinates[0] }
        }).filter((place: PlaceSuggestion) => Number.isFinite(place.latitude) && Number.isFinite(place.longitude))
        setPlaceSuggestions(suggestions)
      } catch {
        if (!controller.signal.aborted) setPlaceSuggestions([])
      } finally {
        if (!controller.signal.aborted) setSearchingPlaces(false)
      }
    }, 700)
    return () => { clearTimeout(timer); controller.abort() }
  }, [journey.destination, journey.latitude, journey.longitude, origin])

  useEffect(() => {
    if (!origin || !journey.latitude || !journey.longitude) { setRouteEstimate(null); setCalculatingRoute(false); return }
    const controller = new AbortController()
    const destinationLatitude = Number(journey.latitude)
    const destinationLongitude = Number(journey.longitude)
    const timer = setTimeout(async () => {
      setCalculatingRoute(true)
      try {
        const coordinates = `${origin.longitude},${origin.latitude};${destinationLongitude},${destinationLatitude}`
        const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=false`, { signal: controller.signal })
        if (!response.ok) throw new Error('Could not calculate a driving route.')
        const result = await response.json()
        const route = result.routes?.[0]
        if (result.code !== 'Ok' || !route) throw new Error('No driving route found for these locations.')
        setRouteEstimate({ seconds: route.duration, meters: route.distance })
        setJourney(current => ({ ...current, eta: formatLocalInput(new Date(Date.now() + route.duration * 1000)) }))
      } catch {
        if (!controller.signal.aborted) setRouteEstimate(null)
      } finally {
        if (!controller.signal.aborted) setCalculatingRoute(false)
      }
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [origin, journey.latitude, journey.longitude])

  async function linkAndLoad(showError = true) {
    if (!supabase) return
    const { data, error } = await supabase.from('journeys').select('id,owner_user_id,destination_label,eta,status,contact_name').order('created_at', { ascending: false })
    if (error) { if (showError) Alert.alert('Could not load journeys', error.message); return }
    const loadedJourneys = data ?? []
    setJourneys(loadedJourneys)
    if (!loadedJourneys.length) { setLocationsByJourney({}); return }
    const { data: locations } = await supabase.from('journey_member_locations').select('journey_id,user_id,latitude,longitude,accuracy,updated_at').in('journey_id', loadedJourneys.map(item => item.id))
    const latestLocations: Record<string, SharedLocation> = {}
    for (const item of loadedJourneys) {
      const ownerLocation = (locations ?? []).find(location => location.journey_id === item.id && location.user_id === item.owner_user_id)
      if (ownerLocation) latestLocations[item.id] = { latitude: ownerLocation.latitude, longitude: ownerLocation.longitude, accuracy: ownerLocation.accuracy, updated_at: ownerLocation.updated_at }
    }
    setLocationsByJourney(latestLocations)
  }

  async function loadAppUserId() {
    if (!supabase) return
    const { data } = await supabase.rpc('current_app_user_id')
    setAppUserId(data ?? null)
  }

  async function inviteTrustedContact(item: Journey) {
    if (!supabase) return
    setInvitingJourneyId(item.id)
    try {
      const { data, error } = await supabase.rpc('invite_journey_contact', { target_journey_id: item.id })
      if (error) { Alert.alert('Could not share journey', error.message); return }
      if (data === 'account_not_found') {
        Alert.alert('Contact needs a Here account', 'Ask your trusted contact to create a Here account using the email address you saved for them. Then tap Share with contact again.')
        return
      }
      if (data === 'same_account') { Alert.alert('Choose another contact', 'Your trusted contact must use a different Here account.'); return }
      if (data !== 'invited') { Alert.alert('Could not share journey', 'Please try again.'); return }
      void linkAndLoad()
      await Share.share({ message: `Hi ${item.contact_name}, I shared my Here journey to ${item.destination_label} with you. Sign in to the Here app using the email address I saved for you to see the plan.` })
    } catch (error) {
      Alert.alert('Could not share journey', error instanceof Error ? error.message : 'Check your connection and try again.')
    } finally {
      setInvitingJourneyId(null)
    }
  }

  async function startLocationSharing(item: Journey) {
    const client = supabase
    if (!client || !appUserId) { Alert.alert('Profile not ready', 'Please sign out and back in, then try again.'); return }
    if (locationSubscription.current) await stopLocationSharing(trackingJourneyId ?? undefined)
    try {
      const permission = await Location.requestForegroundPermissionsAsync()
      if (!permission.granted) { Alert.alert('Location permission needed', 'Allow location access to share your live position during this journey.'); return }
      const saveLocation = async (point: Location.LocationObject) => {
        const now = new Date().toISOString()
        const { error } = await client.from('journey_member_locations').upsert({
          journey_id: item.id, user_id: appUserId, latitude: point.coords.latitude,
          longitude: point.coords.longitude, accuracy: point.coords.accuracy, updated_at: now,
        }, { onConflict: 'journey_id,user_id' })
        if (error) throw error
      }
      await saveLocation(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }))
      locationSubscription.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 15000, distanceInterval: 25 },
        point => { void saveLocation(point).catch(error => Alert.alert('Location not shared', error instanceof Error ? error.message : 'Check your connection.')) },
      )
      setTrackingJourneyId(item.id)
      void linkAndLoad(false)
    } catch (error) {
      Alert.alert('Could not start location sharing', error instanceof Error ? error.message : 'Check your location settings and try again.')
    }
  }

  async function stopLocationSharing(journeyId = trackingJourneyId ?? undefined) {
    if (!journeyId) return
    if (trackingJourneyId === journeyId || !trackingJourneyId) {
      locationSubscription.current?.remove()
      locationSubscription.current = null
      setTrackingJourneyId(null)
    }
    if (supabase && appUserId) {
      const { error } = await supabase.from('journey_member_locations').delete().eq('journey_id', journeyId).eq('user_id', appUserId)
      if (error) Alert.alert('Could not stop sharing', error.message)
      else void linkAndLoad(false)
    }
  }

  async function sendChatMessage(journeyId: string) {
    if (!supabase || !appUserId || sendingMessage) return
    const body = chatDraft.trim()
    if (!body) return
    setSendingMessage(true)
    const { error } = await supabase.from('journey_messages').insert({ id: Crypto.randomUUID(), journey_id: journeyId, user_id: appUserId, body, created_at: new Date().toISOString() })
    setSendingMessage(false)
    if (error) Alert.alert('Message not sent', error.message)
    else { setChatDraft(''); void loadChatMessages(journeyId) }
  }

  async function loadIncidentReports() {
    if (!supabase) return
    const { data, error } = await supabase.from('incident_reports')
      .select('id,title,description,category,latitude,longitude,received_at,verification_status')
      .eq('is_visible', 1).gt('expires_at', new Date().toISOString())
      .order('received_at', { ascending: false }).limit(100)
    if (error) { setIncidentLoadError('Could not load community reports.'); return }
    const reports = (data ?? []) as Incident[]
    setIncidents(reports)
    setIncidentLoadError('')
    if (!origin && reports[0]) setIncidentMapRegion({ latitude: reports[0].latitude, longitude: reports[0].longitude, latitudeDelta: 0.12, longitudeDelta: 0.12 })
  }

  async function loadChatMessages(journeyId: string) {
    if (!supabase) return
    const { data } = await supabase.from('journey_messages').select('id,journey_id,user_id,body,created_at')
      .eq('journey_id', journeyId).order('created_at', { ascending: true }).limit(100)
    if (data) setChatMessages(data)
  }

  async function authenticate() {
    if (!supabase) return
    const email = form.email.trim()
    const password = form.password
    if (!email || !password) {
      Alert.alert('Enter your details', 'Type your email address and password, then try again.')
      return
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      Alert.alert('Check your email', 'Enter a complete email address, for example name@example.com.')
      return
    }
    if (registering && !form.name.trim()) {
      Alert.alert('Enter your name', 'Add your name so your trusted contacts know who shared the journey.')
      return
    }
    if (registering && password.length < 6) {
      Alert.alert('Password too short', 'Choose a password with at least 6 characters.')
      return
    }

    setBusy(true)
    try {
      const result = registering
        ? await supabase.auth.signUp({ email, password, options: { data: { display_name: form.name.trim() } } })
        : await supabase.auth.signInWithPassword({ email, password })

      if (result.error) {
        const message = result.error.message.toLowerCase()
        if (message.includes('email address not authorized')) {
          Alert.alert('Email setup needed', 'Supabase is only allowed to send confirmation emails to project team members right now. Connect an email sender (SMTP) in Supabase so new users can receive their confirmation link.')
        } else if (message.includes('rate limit') || message.includes('too many requests')) {
          Alert.alert('Too many attempts', 'Please wait a little while before trying again. A proper email sender in Supabase also raises the small testing email limit.')
        } else if (message.includes('email not confirmed')) {
          Alert.alert('Confirm your email first', 'Open the confirmation link in your email, then return here and sign in.')
        } else {
          Alert.alert(registering ? 'Could not create account' : 'Could not sign in', result.error.message)
        }
      } else if (registering && !result.data.session) {
        Alert.alert('Check your email', 'We sent you a confirmation link. Open it, then return here and sign in.')
      } else if (result.data.session) {
        const linked = await supabase.functions.invoke('link-legacy-account', { body: { password } })
        if (linked.error) Alert.alert('Account linking', linked.error.message)
        else if (linked.data?.error) Alert.alert('Account linking', linked.data.error)
        void linkAndLoad()
      }
    } catch (error) {
      Alert.alert(
        'Connection problem',
        error instanceof Error ? `${error.message}\n\nCheck your internet connection and try again.` : 'Could not reach the sign-in service. Check your internet connection and try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function createJourney() {
    if (!supabase || !session) return
    const lat = Number(journey.latitude), lon = Number(journey.longitude)
    const eta = new Date(journey.eta)
    if (!journey.destination.trim() || !journey.latitude || !journey.longitude || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180 || Number.isNaN(eta.getTime()) || !journey.contact.trim() || !journey.contactEmail.trim()) {
      Alert.alert('Complete the journey details', 'Choose a destination from the suggestions, check the arrival time, and enter your trusted contact.')
      return
    }
    setBusy(true)
    const owner = await supabase.rpc('current_app_user_id')
    if (owner.error || !owner.data) { setBusy(false); Alert.alert('Profile not ready', owner.error?.message ?? 'Sign in again after confirming your email.'); return }
    const now = new Date().toISOString()
    const created = await supabase.from('journeys').insert({
      id: Crypto.randomUUID(), owner_user_id: owner.data, destination_lat: lat, destination_lon: lon,
      origin_lat: origin?.latitude ?? null, origin_lon: origin?.longitude ?? null,
      destination_label: journey.destination.trim(), eta: eta.toISOString(), grace_period_seconds: 900,
      contact_name: journey.contact.trim(), contact_email: journey.contactEmail.trim(), status: 'ACTIVE',
      created_at: now, updated_at: now,
    })
    setBusy(false)
    if (created.error) Alert.alert('Could not create journey', created.error.message)
    else { setShowJourneyForm(false); setActiveTab('journeys'); setJourney({ destination: '', latitude: '', longitude: '', eta: '', contact: '', contactEmail: '' }); setOrigin(null); void linkAndLoad() }
  }

  async function updateJourney(item: Journey, action: 'arrive' | 'extend' | 'cancel') {
    if (!supabase) return
    const now = new Date().toISOString()
    const changes = action === 'arrive'
      ? { status: 'ARRIVED', arrived_at: now, updated_at: now }
      : action === 'extend'
        ? { eta: new Date(new Date(item.eta).getTime() + 30 * 60 * 1000).toISOString(), status: 'ACTIVE', updated_at: now }
        : { status: 'CANCELLED', updated_at: now }
    setBusy(true)
    const { data, error } = await supabase.from('journeys').update(changes).eq('id', item.id).select('id').maybeSingle()
    setBusy(false)
    if (error) Alert.alert('Could not update journey', error.message)
    else if (!data) Alert.alert('Journey not updated', 'Please sign out and back in, then try again.')
    else {
      if (action === 'extend') Alert.alert('More time added', 'Your arrival time was moved 30 minutes later.')
      if (action === 'cancel') Alert.alert('Journey cancelled', 'This journey is no longer active.')
      if (action !== 'extend' && trackingJourneyId === item.id) await stopLocationSharing(item.id)
      void linkAndLoad()
    }
  }

  async function signOut() {
    if (trackingJourneyId) await stopLocationSharing(trackingJourneyId)
    await supabase?.auth.signOut()
    setActiveTab('home')
    setShowJourneyForm(false)
    setQuickMenuOpen(false)
    setJourneyMenuOpenId(null)
  }

  function confirmCancel(item: Journey) {
    Alert.alert('Cancel this journey?', 'Your trusted contact will no longer see this as an active plan.', [
      { text: 'Keep journey', style: 'cancel' },
      { text: 'Cancel journey', style: 'destructive', onPress: () => void updateJourney(item, 'cancel') },
    ])
  }

  async function submitIncidentReport() {
    if (!supabase || !reportingJourneyId) return
    if (!reportDescription.trim()) { Alert.alert('Add a short description', 'Tell us what is happening.'); return }
    setReportBusy(true)
    try {
      const permission = await Location.requestForegroundPermissionsAsync()
      if (!permission.granted) { Alert.alert('Location permission needed', 'Allow location access so this report is placed where you are.'); return }
      const [position, owner] = await Promise.all([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        supabase.rpc('current_app_user_id'),
      ])
      if (owner.error || !owner.data) { Alert.alert('Profile not ready', owner.error?.message ?? 'Please sign in again, then retry.'); return }
      const now = new Date()
      const selectedType = incidentTypes.find(type => type.key === reportCategory) ?? incidentTypes[7]
      const { error } = await supabase.from('incident_reports').insert({
        id: Crypto.randomUUID(), title: `${selectedType.label} reported`, description: reportDescription.trim(),
        category: reportCategory, source_type: 'community', reported_at: now.toISOString(), received_at: now.toISOString(),
        latitude: position.coords.latitude, longitude: position.coords.longitude,
        location_accuracy_m: Math.round(position.coords.accuracy ?? 0), verification_status: 'unverified',
        expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), is_visible: 1,
        created_by: owner.data,
      })
      if (error) { Alert.alert('Report not sent', error.message); return }
      setReportingJourneyId(null)
      setReportDescription('')
      void loadIncidentReports()
      Alert.alert('Report received', 'Your report was saved with your current location. Community reports are unverified.')
    } catch (error) {
      Alert.alert('Report not sent', error instanceof Error ? error.message : 'Check your connection and try again.')
    } finally {
      setReportBusy(false)
    }
  }

  function journeysForQuickAction(action: QuickAction) {
    if (action === 'chat') return journeys
    const activeJourneys = journeys.filter(item => ['ACTIVE', 'OVERDUE_PENDING', 'OVERDUE_NOTIFIED'].includes(item.status))
    return action === 'report' ? activeJourneys : activeJourneys.filter(item => item.owner_user_id === appUserId)
  }

  function runQuickAction(item: Journey) {
    if (!quickAction) return
    const action = quickAction
    setQuickMenuOpen(false)
    setQuickAction(null)
    if (action === 'chat') {
      setReportingJourneyId(null)
      setOpenChatJourneyId(item.id)
      setActiveTab('chat')
    } else if (action === 'report') {
      setOpenChatJourneyId(null)
      setReportDescription('')
      setReportingJourneyId(item.id)
      setActiveTab('journeys')
    } else if (action === 'live') {
      setOpenChatJourneyId(null)
      setReportingJourneyId(null)
      setActiveTab('journeys')
      if (trackingJourneyId === item.id) void stopLocationSharing(item.id)
      else void startLocationSharing(item)
    } else {
      void inviteTrustedContact(item)
    }
    if (action === 'report' || action === 'live') {
      setTimeout(() => {
        const top = journeyCardOffsets.current[item.id]
        if (top !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, top - 14), animated: true })
      }, 220)
    }
  }

  function openQuickAction(action: QuickAction) {
    setQuickAction(action)
    setQuickMenuOpen(true)
    setJourneyMenuOpenId(null)
  }

  function runJourneyMenuAction(action: QuickAction, item: Journey) {
    setJourneyMenuOpenId(null)
    if (action === 'chat') {
      setReportingJourneyId(null)
      setOpenChatJourneyId(item.id)
      setActiveTab('chat')
    } else if (action === 'report') {
      setOpenChatJourneyId(null)
      setReportDescription('')
      setReportingJourneyId(item.id)
      setActiveTab('journeys')
    } else if (action === 'live') {
      setOpenChatJourneyId(null)
      setReportingJourneyId(null)
      setActiveTab('journeys')
      if (trackingJourneyId === item.id) void stopLocationSharing(item.id)
      else void startLocationSharing(item)
    } else {
      void inviteTrustedContact(item)
    }
    if (action === 'report' || action === 'live') {
      setTimeout(() => {
        const top = journeyCardOffsets.current[item.id]
        if (top !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, top - 14), animated: true })
      }, 220)
    }
  }

  function renderJourneyMenu(item: Journey, active: boolean, isOwner: boolean) {
    return <>
      <View style={styles.cardHeadRow}>
        <View style={styles.cardHead}><View style={[styles.dot, item.status === 'OVERDUE_PENDING' && styles.overdueDot]} /><Text style={[styles.status, item.status === 'OVERDUE_PENDING' && styles.overdueStatus]}>{journeyStatusLabel(item.status)}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={`More options for ${item.destination_label}`} onPress={() => setJourneyMenuOpenId(journeyMenuOpenId === item.id ? null : item.id)} style={styles.cardMoreButton}><Text style={styles.cardMoreText}>⋯</Text></Pressable>
      </View>
      {journeyMenuOpenId === item.id && <View style={styles.cardMoreMenu}>
        <Pressable onPress={() => runJourneyMenuAction('chat', item)} style={styles.cardMoreRow}><Text style={styles.quickMenuTitle}>Open chat</Text></Pressable>
        {active && <Pressable onPress={() => runJourneyMenuAction('report', item)} style={styles.cardMoreRow}><Text style={styles.quickMenuTitle}>Report an incident</Text></Pressable>}
        {active && isOwner && <Pressable onPress={() => runJourneyMenuAction('live', item)} style={styles.cardMoreRow}><Text style={styles.quickMenuTitle}>{trackingJourneyId === item.id ? 'Stop live location' : 'Share live location'}</Text></Pressable>}
        {active && isOwner && <Pressable disabled={invitingJourneyId === item.id} onPress={() => runJourneyMenuAction('share', item)} style={styles.cardMoreRow}>{invitingJourneyId === item.id ? <ActivityIndicator color={green} /> : <Text style={styles.quickMenuTitle}>Share journey</Text>}</Pressable>}
        {active && isOwner && <Pressable onPress={() => { setJourneyMenuOpenId(null); confirmCancel(item) }} style={styles.cardMoreRow}><Text style={styles.cancelText}>Cancel journey</Text></Pressable>}
      </View>}
    </>
  }

  function renderCommunityMap(compact = false) {
    return <View style={styles.incidentMapCard}>
      <View style={styles.incidentMapHeader}><View><Text style={styles.section}>Community reports</Text><Text style={styles.copy}>{incidents.length ? `${incidents.length} recent report${incidents.length === 1 ? '' : 's'}` : 'No recent reports yet'}</Text></View><Pressable onPress={() => void useCurrentLocation()}><Text style={styles.link}>Center on me</Text></Pressable></View>
      {incidentLoadError ? <Text style={styles.reportNote}>{incidentLoadError}</Text> : <View style={[styles.incidentMapFrame, compact && styles.homeMapFrame]}><MapView style={styles.map} region={incidentMapRegion} onRegionChangeComplete={setIncidentMapRegion}>
        {incidents.map(report => <Marker key={report.id} coordinate={{ latitude: report.latitude, longitude: report.longitude }} title={report.title} description={`${report.verification_status.replaceAll('_', ' ')} · ${report.description}`} pinColor={report.verification_status === 'confirmed' ? '#278660' : '#ce6d54'} />)}
        {origin && <Marker coordinate={origin} title="Your current location" pinColor={green} />}
      </MapView></View>}
      {!compact && <Text style={styles.reportNote}>Community reports are unverified unless marked confirmed. For emergencies, contact local emergency services.</Text>}
      {!!incidentLoadError && <Pressable onPress={() => void loadIncidentReports()} style={styles.retryReports}><Text style={styles.link}>Try again</Text></Pressable>}
      {compact && <Pressable onPress={() => setActiveTab('map')} style={styles.mapOpenButton}><Text style={styles.link}>Open community map  →</Text></Pressable>}
    </View>
  }

  function renderJourneyCard(item: Journey, compact = false) {
    const active = ['ACTIVE', 'OVERDUE_PENDING', 'OVERDUE_NOTIFIED'].includes(item.status)
    const isOwner = item.owner_user_id === appUserId
    const liveLocation = locationsByJourney[item.id]
    const locationIsFresh = liveLocation && Date.now() - new Date(liveLocation.updated_at).getTime() < 120000
    return <View style={styles.card} key={item.id} onLayout={event => { journeyCardOffsets.current[item.id] = event.nativeEvent.layout.y }}>
      {renderJourneyMenu(item, active, isOwner)}
      <Text style={styles.destination}>{item.destination_label}</Text>
      <Text style={styles.copy}>Arrive by {new Date(item.eta).toLocaleString()}</Text>
      {!compact && <Text style={styles.contact}>Shared with {item.contact_name}</Text>}
      {active && isOwner && <View style={styles.actions}>
        <Pressable disabled={busy} onPress={() => void updateJourney(item, 'arrive')} style={styles.actionButton}><Text style={styles.actionText}>I arrived</Text></Pressable>
        <Pressable disabled={busy} onPress={() => void updateJourney(item, 'extend')} style={styles.actionButton}><Text style={styles.actionText}>+30 min</Text></Pressable>
      </View>}
      {liveLocation && <View style={styles.liveLocationPanel}>
        <Text style={styles.liveLocationLabel}>{locationIsFresh ? 'Live location' : 'Last shared location'} · {new Date(liveLocation.updated_at).toLocaleTimeString()}</Text>
        <View style={styles.liveMapFrame}><MapView style={styles.map} initialRegion={{ latitude: liveLocation.latitude, longitude: liveLocation.longitude, latitudeDelta: 0.025, longitudeDelta: 0.025 }}>
          <Marker coordinate={{ latitude: liveLocation.latitude, longitude: liveLocation.longitude }} title={locationIsFresh ? 'Shared live location' : 'Last shared location'} description={new Date(liveLocation.updated_at).toLocaleString()} pinColor={green} />
        </MapView></View>
        {isOwner && trackingJourneyId === item.id && <Text style={styles.reportNote}>Here shares your position while this screen is open. Stop sharing any time.</Text>}
      </View>}
      {active && !isOwner && <Text style={styles.sharedNote}>You can view this shared journey.</Text>}
      {reportingJourneyId === item.id && <View style={styles.reportForm}>
        <Text style={styles.section}>What is happening?</Text>
        <View style={styles.categoryList}>{incidentTypes.map(type => <Pressable key={type.key} onPress={() => setReportCategory(type.key)} style={[styles.categoryChip, reportCategory === type.key && styles.categoryChipSelected]}><Text style={[styles.categoryText, reportCategory === type.key && styles.categoryTextSelected]}>{type.label}</Text></Pressable>)}</View>
        <TextInput value={reportDescription} onChangeText={setReportDescription} style={styles.reportInput} placeholder="Add a short description" placeholderTextColor="#a6afab" multiline maxLength={500} textAlignVertical="top" />
        <Text style={styles.reportNote}>Your current location will be attached. Reports are unverified and expire after 7 days. For emergencies, contact local emergency services.</Text>
        <Pressable disabled={reportBusy} onPress={() => void submitIncidentReport()} style={styles.reportSubmit}>{reportBusy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryText}>Send report</Text>}</Pressable>
      </View>}
    </View>
  }

  function renderChatPanel(item: Journey) {
    return <View style={styles.chatPanel}>
      {chatMessages.length === 0 ? <Text style={styles.reportNote}>No messages yet. Say hello.</Text> : chatMessages.map(message => <View key={message.id} style={styles.chatMessage}><Text style={styles.chatAuthor}>{message.user_id === appUserId ? 'You' : 'Contact'} · {new Date(message.created_at).toLocaleTimeString()}</Text><Text style={styles.chatBody}>{message.body}</Text></View>)}
      <View style={styles.chatComposer}><TextInput value={chatDraft} onChangeText={setChatDraft} style={styles.chatInput} placeholder="Write a message" placeholderTextColor="#a6afab" maxLength={1000} returnKeyType="send" onSubmitEditing={() => void sendChatMessage(item.id)} /><Pressable disabled={sendingMessage || !chatDraft.trim()} onPress={() => void sendChatMessage(item.id)} style={styles.chatSend}><Text style={styles.chatSendText}>{sendingMessage ? '…' : 'Send'}</Text></Pressable></View>
    </View>
  }

  async function useCurrentLocation() {
    try {
      const permission = await Location.requestForegroundPermissionsAsync()
      if (!permission.granted) { Alert.alert('Location permission needed', 'Allow location access so Here can estimate the trip from where you are.'); return }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude }
      setOrigin(point)
      setMapRegion({ ...point, latitudeDelta: 0.04, longitudeDelta: 0.04 })
      setIncidentMapRegion({ ...point, latitudeDelta: 0.12, longitudeDelta: 0.12 })
    } catch {
      Alert.alert('Could not get your location', 'Check that location is turned on, then try again.')
    }
  }

  function chooseDestination(place: PlaceSuggestion) {
    setJourney(current => ({ ...current, destination: place.label, latitude: String(place.latitude), longitude: String(place.longitude), eta: '' }))
    setPlaceSuggestions([])
    if (origin) {
      const latitudeDelta = Math.max(Math.abs(origin.latitude - place.latitude) * 1.6, 0.04)
      const longitudeDelta = Math.max(Math.abs(origin.longitude - place.longitude) * 1.6, 0.04)
      setMapRegion({ latitude: (origin.latitude + place.latitude) / 2, longitude: (origin.longitude + place.longitude) / 2, latitudeDelta, longitudeDelta })
    } else setMapRegion({ latitude: place.latitude, longitude: place.longitude, latitudeDelta: 0.04, longitudeDelta: 0.04 })
  }

  const currentActiveJourney = journeys.find(item => ['ACTIVE', 'OVERDUE_PENDING', 'OVERDUE_NOTIFIED'].includes(item.status)) ?? null
  const selectedChatJourney = journeys.find(item => item.id === openChatJourneyId) ?? null

  if (loading) return <SafeAreaView style={styles.center}><ActivityIndicator color={green} /></SafeAreaView>
  if (!supabase) return <SafeAreaView style={styles.center}><Text style={styles.title}>Connect Supabase</Text><Text style={styles.copy}>Copy mobile/.env.example to mobile/.env and add your project URL and publishable key.</Text></SafeAreaView>

  return <SafeAreaView style={styles.safe}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView ref={scrollRef} style={styles.flexScroll} contentContainerStyle={[styles.page, !session && styles.authPage]} keyboardShouldPersistTaps="handled">
        <View style={styles.top}>
          <View><AnimatedBrandMark active={playBrandAnimation} /><Text style={styles.kicker}>stay connected to every journey</Text></View>
          {session && <View style={styles.headerActions}>
            <Pressable onPress={() => void signOut()}><Text style={styles.link}>Sign out</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={quickMenuOpen ? 'Close more options' : 'Open more options'} onPress={() => { setQuickMenuOpen(!quickMenuOpen); setQuickAction(null) }} style={styles.menuButton}>
              <Text style={styles.menuButtonText}>{quickMenuOpen ? '×' : '⋯'}</Text>
            </Pressable>
          </View>}
        </View>
        {session && quickMenuOpen && !showJourneyForm && <View style={styles.quickMenu}>
          <Text style={styles.section}>{quickAction ? 'Choose a journey' : 'More options'}</Text>
          {!quickAction ? <>
            <Pressable onPress={() => setQuickAction('chat')} style={styles.quickMenuRow}><Text style={styles.quickMenuTitle}>Chat</Text><Text style={styles.quickMenuDetail}>Open a journey conversation</Text></Pressable>
            <Pressable onPress={() => setQuickAction('live')} style={styles.quickMenuRow}><Text style={styles.quickMenuTitle}>{trackingJourneyId ? 'Manage live location' : 'Share live location'}</Text><Text style={styles.quickMenuDetail}>Choose one of your active journeys</Text></Pressable>
            <Pressable onPress={() => setQuickAction('report')} style={styles.quickMenuRow}><Text style={styles.quickMenuTitle}>Report an incident</Text><Text style={styles.quickMenuDetail}>Add a report to an active journey</Text></Pressable>
            <Pressable onPress={() => setQuickAction('share')} style={styles.quickMenuRow}><Text style={styles.quickMenuTitle}>Share a journey</Text><Text style={styles.quickMenuDetail}>Invite your trusted contact</Text></Pressable>
          </> : <>
            {journeysForQuickAction(quickAction).length === 0
              ? <Text style={styles.quickMenuDetail}>There isn’t a journey available for this option yet.</Text>
              : journeysForQuickAction(quickAction).map(item => <Pressable key={item.id} onPress={() => runQuickAction(item)} style={styles.quickMenuRow}><Text style={styles.quickMenuTitle}>{item.destination_label}</Text><Text style={styles.quickMenuDetail}>{quickAction === 'live' && trackingJourneyId === item.id ? 'Sharing live location now' : journeyStatusLabel(item.status)}</Text></Pressable>)}
            <Pressable onPress={() => setQuickAction(null)} style={styles.quickMenuBack}><Text style={styles.link}>Back to options</Text></Pressable>
          </>}
        </View>}
        {!session ? <View style={styles.authCard}>
          <Text style={styles.title}>{registering ? 'Create your account' : 'Welcome back'}</Text>
          <Text style={styles.copy}>Plan a journey and let someone you trust know when you expect to arrive.</Text>
          {registering && <Field label="Your name" value={form.name} onChangeText={v => setForm({ ...form, name: v })} />}
          <Field label="Email" value={form.email} onChangeText={v => setForm({ ...form, email: v })} keyboardType="email-address" autoCapitalize="none" />
          <Field label="Password" value={form.password} onChangeText={v => setForm({ ...form, password: v })} secureTextEntry />
          <Primary title={registering ? 'Create account' : 'Continue'} busy={busy} onPress={authenticate} />
          <Pressable onPress={() => setRegistering(!registering)} style={styles.switch}><Text style={styles.link}>{registering ? 'I already have an account' : 'Create an account'}</Text></Pressable>
        </View> : showJourneyForm ? <>
          <Pressable onPress={() => { setShowJourneyForm(false); setActiveTab('home'); setQuickMenuOpen(false) }} style={styles.backButton}><Text style={styles.link}>‹  Home</Text></Pressable>
          <View style={styles.heading}><Text style={styles.title}>Plan a journey</Text><Text style={styles.copy}>Choose where you’re going and who should know when you arrive.</Text></View>
          <View style={styles.card}>
            <Text style={styles.section}>Journey details</Text>
            <Field label="Type a destination" value={journey.destination} onChangeText={v => setJourney(current => ({ ...current, destination: v, latitude: '', longitude: '', eta: '' }))} autoCapitalize="words" />
            {searchingPlaces && <ActivityIndicator style={styles.searchSpinner} color={green} />}
            {placeSuggestions.map((place, index) => <Pressable key={`${place.latitude}-${place.longitude}-${index}`} onPress={() => chooseDestination(place)} style={styles.suggestion}><Text style={styles.suggestionTitle}>{place.label.split(',')[0]}</Text><Text style={styles.suggestionDetail}>{place.label}</Text></Pressable>)}
            {!origin && <Pressable onPress={useCurrentLocation} style={styles.locationHint}><Text style={styles.link}>Use my current location to estimate travel time</Text></Pressable>}
            {routeEstimate && <Text style={styles.routeSummary}>About {formatDuration(routeEstimate.seconds)} by car · {(routeEstimate.meters / 1000).toFixed(1)} km. Estimated time; traffic may change it.</Text>}
            {calculatingRoute && <Text style={styles.routeSummary}>Calculating driving time…</Text>}
            <View style={styles.mapFrame}><MapView style={styles.map} region={mapRegion} showsUserLocation={!!origin} scrollEnabled={false} zoomEnabled={false}>
              {!!journey.latitude && !!journey.longitude && <Marker coordinate={{ latitude: Number(journey.latitude), longitude: Number(journey.longitude) }} title={journey.destination || 'Destination'} />}
              {origin && <Marker coordinate={origin} title="Journey origin" pinColor={green} />}
            </MapView></View>
            <Text style={styles.coordinates}>Place search and route data © OpenStreetMap contributors.</Text>
            <Field label="Estimated arrival time (you can change it)" value={journey.eta} onChangeText={v => setJourney({ ...journey, eta: v })} />
            <Text style={styles.section}>Trusted contact</Text>
            <Field label="Contact name" value={journey.contact} onChangeText={v => setJourney({ ...journey, contact: v })} />
            <Field label="Contact email" value={journey.contactEmail} onChangeText={v => setJourney({ ...journey, contactEmail: v })} keyboardType="email-address" autoCapitalize="none" />
            <Primary title="Save journey" busy={busy} onPress={createJourney} />
          </View>
        </> : activeTab === 'home' ? <>
          <View style={styles.homeHero}>
            <Text style={styles.title}>Plan your journey</Text>
            <Text style={styles.copy}>A little more peace of mind for the people who care.</Text>
            <Pressable onPress={() => { setShowJourneyForm(true); setQuickMenuOpen(false); if (!origin) void useCurrentLocation() }} style={styles.homePlanButton}><Text style={styles.homePlanText}>＋  Plan a journey</Text></Pressable>
          </View>
          <View style={styles.heading}><Text style={styles.section}>Quick actions</Text><Text style={styles.copy}>Tap a shortcut to get started.</Text></View>
          <View style={styles.shortcutGrid}>
            <Pressable onPress={() => openQuickAction('live')} style={styles.shortcutTile}><Text style={styles.shortcutIcon}>⌖</Text><Text style={styles.shortcutTitle}>Share live</Text></Pressable>
            <Pressable onPress={() => openQuickAction('report')} style={styles.shortcutTile}><Text style={[styles.shortcutIcon, styles.reportShortcutIcon]}>!</Text><Text style={styles.shortcutTitle}>Report incident</Text></Pressable>
            <Pressable onPress={() => openQuickAction('chat')} style={styles.shortcutTile}><Text style={styles.shortcutIcon}>▤</Text><Text style={styles.shortcutTitle}>Chat</Text></Pressable>
            <Pressable onPress={() => openQuickAction('share')} style={styles.shortcutTile}><Text style={styles.shortcutIcon}>↗</Text><Text style={styles.shortcutTitle}>Share journey</Text></Pressable>
          </View>
          <View style={styles.homeSectionHeading}><Text style={styles.section}>Active journey</Text><Pressable onPress={() => setActiveTab('journeys')}><Text style={styles.link}>See all</Text></Pressable></View>
          {currentActiveJourney ? renderJourneyCard(currentActiveJourney, true) : <View style={styles.empty}><Text style={styles.emptyIcon}>⌁</Text><Text style={styles.section}>No active journey</Text><Text style={styles.copy}>Your next plan will show here.</Text></View>}
          <View style={styles.homeSectionHeading}><Text style={styles.section}>Community map</Text><Pressable onPress={() => setActiveTab('map')}><Text style={styles.link}>Open map</Text></Pressable></View>
          {renderCommunityMap(true)}
        </> : activeTab === 'journeys' ? <>
          <View style={styles.heading}><Text style={styles.title}>Your journeys</Text><Text style={styles.copy}>Active plans and trips shared with you.</Text></View>
          {journeys.length === 0 ? <View style={styles.empty}><Text style={styles.emptyIcon}>⌁</Text><Text style={styles.section}>No journeys yet</Text><Text style={styles.copy}>Plan a journey to get started.</Text><Primary title="Plan a journey" busy={false} onPress={() => { setActiveTab('home'); setShowJourneyForm(true); if (!origin) void useCurrentLocation() }} /></View> : journeys.map(item => renderJourneyCard(item))}
        </> : activeTab === 'map' ? <>
          <View style={styles.heading}><Text style={styles.title}>Community map</Text><Text style={styles.copy}>See recent reports near you.</Text></View>
          {renderCommunityMap()}
        </> : <>
          <View style={styles.heading}><Text style={styles.title}>Chat</Text><Text style={styles.copy}>Messages for your shared journeys.</Text></View>
          {journeys.length === 0 ? <View style={styles.empty}><Text style={styles.section}>No conversations yet</Text><Text style={styles.copy}>A shared journey conversation will show here.</Text></View> : <>
            {journeys.map(item => <Pressable key={item.id} onPress={() => setOpenChatJourneyId(item.id)} style={[styles.chatJourneyRow, openChatJourneyId === item.id && styles.chatJourneyRowSelected]}><View><Text style={styles.quickMenuTitle}>{item.destination_label}</Text><Text style={styles.quickMenuDetail}>{journeyStatusLabel(item.status)} · {item.contact_name}</Text></View><Text style={styles.link}>{openChatJourneyId === item.id ? 'Open' : 'View'}</Text></Pressable>)}
            {selectedChatJourney ? renderChatPanel(selectedChatJourney) : <Text style={styles.reportNote}>Choose a journey above to open its chat.</Text>}
          </>}
        </>}
      </ScrollView>
      {session && !showJourneyForm && <View style={styles.bottomTabBar}>
        {([{ key: 'home', icon: '⌂', label: 'Home' }, { key: 'journeys', icon: '↗', label: 'Journeys' }, { key: 'map', icon: '◎', label: 'Map' }, { key: 'chat', icon: '▤', label: 'Chat' }] as const).map(tab => <Pressable key={tab.key} accessibilityRole="button" accessibilityState={{ selected: activeTab === tab.key }} onPress={() => { setActiveTab(tab.key); setQuickMenuOpen(false); setQuickAction(null); setJourneyMenuOpenId(null); scrollRef.current?.scrollTo({ y: 0, animated: false }) }} style={styles.bottomTabItem}>
          <Text style={[styles.bottomTabIcon, activeTab === tab.key && styles.bottomTabActive]}>{tab.icon}</Text>
          <Text style={[styles.bottomTabLabel, activeTab === tab.key && styles.bottomTabActive]}>{tab.label}</Text>
        </Pressable>)}
      </View>}
    </KeyboardAvoidingView>
  </SafeAreaView>
}

function Field(props: { label: string; value: string; onChangeText: (value: string) => void; [key: string]: any }) {
  const { label, ...inputProps } = props
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput {...inputProps} style={styles.input} placeholderTextColor="#a6afab" /></View>
}
function Primary({ title, busy, onPress }: { title: string; busy: boolean; onPress: () => void }) {
  return <Pressable onPress={onPress} disabled={busy} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.85 }]}>{busy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryText}>{title}</Text>}</Pressable>
}

function formatLocalInput(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatDuration(seconds: number) {
  const totalMinutes = Math.max(1, Math.round(seconds / 60))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours ? `${hours} hr${hours === 1 ? '' : 's'}${minutes ? ` ${minutes} min` : ''}` : `${minutes} min`
}

function journeyStatusLabel(status: string) {
  if (status === 'ACTIVE') return 'ON THE WAY'
  if (status === 'OVERDUE_PENDING') return 'CHECK-IN OVERDUE'
  if (status === 'OVERDUE_NOTIFIED') return 'CONTACT NOTIFIED'
  return status.replaceAll('_', ' ')
}

const styles = StyleSheet.create({
  appRoot: { flex: 1 }, intro: { ...StyleSheet.absoluteFill, zIndex: 10, backgroundColor: '#f5f7f5' }, introCenter: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 }, introLogo: { width: 320, height: 96 }, introTagline: { color: '#18221f', fontSize: 17, fontWeight: '600', letterSpacing: 0.2, textAlign: 'center', marginTop: 14 },
  safe: { flex: 1, backgroundColor: '#f5f7f5' }, center: { flex: 1, backgroundColor: '#f5f7f5', justifyContent: 'center', alignItems: 'center', padding: 32 }, flexScroll: { flex: 1 }, page: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 18, paddingBottom: 22, maxWidth: 600, width: '100%', alignSelf: 'center' }, authPage: { justifyContent: 'center', paddingTop: 24, paddingBottom: 24 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }, headerActions: { flexDirection: 'row', alignItems: 'center', gap: 14 }, menuButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'white', alignItems: 'center', justifyContent: 'center', shadowColor: '#23352e', shadowOpacity: 0.08, shadowRadius: 8, elevation: 2 }, menuButtonText: { color: green, fontSize: 22, fontWeight: '600', lineHeight: 26 }, quickMenu: { backgroundColor: 'white', borderRadius: 19, padding: 16, marginBottom: 20, shadowColor: '#23352e', shadowOpacity: 0.07, shadowRadius: 12, elevation: 2 }, quickMenuRow: { backgroundColor: '#f4f6f4', borderRadius: 13, padding: 13, marginTop: 9 }, quickMenuTitle: { color: ink, fontWeight: '600', fontSize: 14 }, quickMenuDetail: { color: muted, fontSize: 12, lineHeight: 17, marginTop: 4 }, quickMenuBack: { alignSelf: 'flex-start', marginTop: 14 }, backButton: { alignSelf: 'flex-start', paddingVertical: 7, marginBottom: 10 }, brandAnimation: { width: 156, height: 40, marginLeft: -3 }, kicker: { color: muted, fontSize: 12, marginTop: 2 }, heading: { marginBottom: 22 }, title: { color: ink, fontSize: 27, fontWeight: '700', letterSpacing: -0.7 }, copy: { color: muted, fontSize: 14, lineHeight: 21, marginTop: 7 },
  authCard: { backgroundColor: 'white', borderRadius: 24, padding: 22, shadowColor: '#25352f', shadowOpacity: 0.07, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 3 }, field: { flex: 1, marginTop: 17 }, label: { fontSize: 12, color: muted, marginBottom: 8, marginLeft: 3 }, input: { minHeight: 50, backgroundColor: '#f4f6f4', borderRadius: 15, paddingHorizontal: 15, color: ink, fontSize: 15 },
  primary: { minHeight: 52, borderRadius: 17, backgroundColor: green, alignItems: 'center', justifyContent: 'center', marginTop: 21, shadowColor: green, shadowOpacity: 0.17, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 2 }, primaryText: { color: 'white', fontWeight: '600', fontSize: 15 }, switch: { alignItems: 'center', paddingTop: 19 }, link: { color: green, fontSize: 14, fontWeight: '600' },
  addButton: { backgroundColor: 'white', paddingVertical: 17, borderRadius: 17, alignItems: 'center', marginBottom: 18, shadowColor: '#23352e', shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 2 }, addText: { color: green, fontWeight: '600', fontSize: 15 }, card: { backgroundColor: 'white', borderRadius: 21, padding: 19, marginBottom: 14, shadowColor: '#23352e', shadowOpacity: 0.055, shadowRadius: 15, shadowOffset: { width: 0, height: 5 }, elevation: 2 }, cardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 11 }, dot: { width: 8, height: 8, borderRadius: 8, backgroundColor: '#54a789', marginRight: 8 }, overdueDot: { backgroundColor: '#c96f49' }, status: { color: green, fontSize: 11, fontWeight: '700', letterSpacing: 0.6 }, overdueStatus: { color: '#a34831' }, destination: { color: ink, fontWeight: '700', fontSize: 19 }, contact: { color: muted, fontSize: 12, marginTop: 14 }, sharedNote: { color: muted, fontSize: 12, marginTop: 14 }, actions: { flexDirection: 'row', gap: 8, marginTop: 18 }, actionButton: { flex: 1, minHeight: 40, paddingHorizontal: 8, borderRadius: 12, backgroundColor: '#f1f6f3', alignItems: 'center', justifyContent: 'center' }, actionText: { color: green, fontWeight: '600', fontSize: 12 }, cancelText: { color: '#a34848', fontWeight: '600', fontSize: 12 }, reportToggle: { marginTop: 16, alignSelf: 'flex-start' }, reportForm: { marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#edf0ee' }, categoryList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }, categoryChip: { borderRadius: 14, paddingVertical: 8, paddingHorizontal: 11, backgroundColor: '#f1f4f2' }, categoryChipSelected: { backgroundColor: '#dceee7' }, categoryText: { color: muted, fontSize: 12 }, categoryTextSelected: { color: green, fontWeight: '600' }, reportInput: { minHeight: 86, marginTop: 14, padding: 13, borderRadius: 13, backgroundColor: '#f4f6f4', color: ink, fontSize: 14 }, reportNote: { color: muted, fontSize: 11, lineHeight: 16, marginTop: 10 }, reportSubmit: { minHeight: 46, marginTop: 14, borderRadius: 14, backgroundColor: green, alignItems: 'center', justifyContent: 'center' }, section: { color: ink, fontWeight: '600', fontSize: 16, marginBottom: 3 }, row: { flexDirection: 'row', gap: 12 }, mapTools: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }, mapFrame: { height: 250, borderRadius: 19, overflow: 'hidden', marginTop: 10, backgroundColor: '#e8efeb' }, map: { flex: 1 }, coordinates: { color: muted, fontSize: 11, lineHeight: 17, marginTop: 8, marginLeft: 3 }, empty: { alignItems: 'center', backgroundColor: 'white', borderRadius: 22, padding: 30, marginTop: 4 }, emptyIcon: { fontSize: 30, color: '#9bbcaf', marginBottom: 9 }, searchSpinner: { marginTop: 8 }, suggestion: { paddingVertical: 12, paddingHorizontal: 14, backgroundColor: 'white', borderBottomWidth: 1, borderBottomColor: '#edf0ee' }, suggestionTitle: { color: ink, fontWeight: '600', fontSize: 14 }, suggestionDetail: { color: muted, fontSize: 12, marginTop: 3 }, locationHint: { marginTop: 13 }, routeSummary: { color: green, fontSize: 12, lineHeight: 18, marginTop: 11 },
  homeHero: { backgroundColor: 'white', borderRadius: 22, padding: 20, marginBottom: 22, shadowColor: '#23352e', shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 2 }, homePlanButton: { minHeight: 48, marginTop: 17, borderRadius: 15, backgroundColor: green, alignItems: 'center', justifyContent: 'center' }, homePlanText: { color: 'white', fontWeight: '700', fontSize: 15 }, shortcutGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: -10, marginBottom: 24 }, shortcutTile: { flexBasis: '47%', flexGrow: 1, minHeight: 92, backgroundColor: 'white', borderRadius: 17, padding: 14, justifyContent: 'center', shadowColor: '#23352e', shadowOpacity: 0.04, shadowRadius: 10, elevation: 1 }, shortcutIcon: { color: green, fontSize: 25, fontWeight: '600', marginBottom: 7 }, reportShortcutIcon: { color: '#ad5b42' }, shortcutTitle: { color: ink, fontSize: 13, fontWeight: '600' }, homeSectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  bottomTabBar: { height: 66, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', backgroundColor: 'white', borderTopWidth: 1, borderTopColor: '#e8ede9', paddingHorizontal: 8 }, bottomTabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 6 }, bottomTabIcon: { color: '#75827b', fontSize: 21, lineHeight: 25 }, bottomTabLabel: { color: '#75827b', fontSize: 10, marginTop: 2 }, bottomTabActive: { color: green, fontWeight: '700' }, chatJourneyRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, backgroundColor: 'white', borderRadius: 15, marginBottom: 9 }, chatJourneyRowSelected: { borderWidth: 1, borderColor: '#8cbba9' },
  cardHeadRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, cardMoreButton: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f4f6f4', marginTop: -5, marginRight: -5 }, cardMoreText: { color: green, fontSize: 23, lineHeight: 25, fontWeight: '700' }, cardMoreMenu: { backgroundColor: '#f7f8f7', borderRadius: 14, padding: 6, marginBottom: 12 }, cardMoreRow: { paddingHorizontal: 11, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#e8ede9' },
  incidentMapCard: { backgroundColor: 'white', borderRadius: 21, padding: 16, marginBottom: 18, shadowColor: '#23352e', shadowOpacity: 0.055, shadowRadius: 15, shadowOffset: { width: 0, height: 5 }, elevation: 2 }, incidentMapHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }, incidentMapFrame: { height: 220, borderRadius: 16, overflow: 'hidden', backgroundColor: '#e8efeb' }, homeMapFrame: { height: 145 }, mapOpenButton: { alignSelf: 'flex-start', marginTop: 12 }, retryReports: { alignSelf: 'flex-start', marginTop: 8 },
  liveLocationPanel: { marginTop: 14 }, liveLocationLabel: { color: green, fontWeight: '600', fontSize: 12, marginBottom: 8 }, liveMapFrame: { height: 170, borderRadius: 15, overflow: 'hidden', backgroundColor: '#e8efeb' }, chatPanel: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#edf0ee' }, chatMessage: { backgroundColor: '#f4f6f4', borderRadius: 13, padding: 11, marginBottom: 8 }, chatAuthor: { color: muted, fontSize: 10, marginBottom: 4 }, chatBody: { color: ink, fontSize: 14, lineHeight: 20 }, chatComposer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }, chatInput: { flex: 1, minHeight: 44, paddingHorizontal: 13, borderRadius: 13, backgroundColor: '#f4f6f4', color: ink, fontSize: 14 }, chatSend: { minHeight: 42, paddingHorizontal: 15, borderRadius: 13, backgroundColor: green, alignItems: 'center', justifyContent: 'center' }, chatSendText: { color: 'white', fontWeight: '600', fontSize: 13 },
})
