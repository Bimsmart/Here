import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import * as Crypto from 'expo-crypto'
import * as Location from 'expo-location'
import MapView, { Marker, type MapPressEvent, type Region } from 'react-native-maps'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './src/lib/supabase'

type Journey = { id: string; destination_label: string; eta: string; status: string; contact_name: string }
const ink = '#18221f'
const muted = '#78827e'
const green = '#176b55'

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [registering, setRegistering] = useState(false)
  const [busy, setBusy] = useState(false)
  const [journeys, setJourneys] = useState<Journey[]>([])
  const [form, setForm] = useState({ email: '', password: '', name: '' })
  const [showJourneyForm, setShowJourneyForm] = useState(false)
  const [journey, setJourney] = useState({ destination: '', latitude: '', longitude: '', eta: '', contact: '', contactEmail: '' })
  const [origin, setOrigin] = useState<{ latitude: number; longitude: number } | null>(null)
  const [mapRegion, setMapRegion] = useState<Region>({ latitude: 6.5244, longitude: 3.3792, latitudeDelta: 0.12, longitudeDelta: 0.12 })

  useEffect(() => {
    if (!supabase) { setLoading(false); return }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => { if (session) { void linkAndLoad() } else setJourneys([]) }, [session?.user.id])

  async function linkAndLoad() {
    if (!supabase) return
    const { data, error } = await supabase.from('journeys').select('id,destination_label,eta,status,contact_name').order('created_at', { ascending: false })
    if (error) Alert.alert('Could not load journeys', error.message)
    else setJourneys(data ?? [])
  }

  async function authenticate() {
    if (!supabase) return
    setBusy(true)
    const result = registering
      ? await supabase.auth.signUp({ email: form.email.trim(), password: form.password, options: { data: { display_name: form.name.trim() } } })
      : await supabase.auth.signInWithPassword({ email: form.email.trim(), password: form.password })
    setBusy(false)
    if (result.error) Alert.alert('Sign in issue', result.error.message)
    else if (registering && !result.data.session) Alert.alert('Check your email', 'Confirm your email, then sign in to continue.')
    else if (result.data.session) {
      const linked = await supabase.functions.invoke('link-legacy-account', { body: { password: form.password } })
      if (linked.error) Alert.alert('Account linking', linked.error.message)
      else if (linked.data?.error) Alert.alert('Account linking', linked.data.error)
      void linkAndLoad()
    }
  }

  async function createJourney() {
    if (!supabase || !session) return
    const lat = Number(journey.latitude), lon = Number(journey.longitude)
    const eta = new Date(journey.eta)
    if (!journey.destination.trim() || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180 || Number.isNaN(eta.getTime()) || !journey.contact.trim() || !journey.contactEmail.trim()) {
      Alert.alert('Complete the journey details', 'Enter a destination, valid coordinates, arrival time and trusted contact.')
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
    else { setShowJourneyForm(false); setJourney({ destination: '', latitude: '', longitude: '', eta: '', contact: '', contactEmail: '' }); setOrigin(null); void linkAndLoad() }
  }

  async function useCurrentLocation() {
    const permission = await Location.requestForegroundPermissionsAsync()
    if (!permission.granted) { Alert.alert('Location permission needed', 'Allow location access to set the start of this journey.'); return }
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
    const point = { latitude: position.coords.latitude, longitude: position.coords.longitude }
    setOrigin(point)
    setMapRegion({ ...point, latitudeDelta: 0.04, longitudeDelta: 0.04 })
  }

  function selectDestination(event: MapPressEvent) {
    const { latitude, longitude } = event.nativeEvent.coordinate
    setJourney(current => ({ ...current, latitude: latitude.toFixed(6), longitude: longitude.toFixed(6) }))
  }

  if (loading) return <SafeAreaView style={styles.center}><ActivityIndicator color={green} /></SafeAreaView>
  if (!supabase) return <SafeAreaView style={styles.center}><Text style={styles.title}>Connect Supabase</Text><Text style={styles.copy}>Copy mobile/.env.example to mobile/.env and add your project URL and publishable key.</Text></SafeAreaView>

  return <SafeAreaView style={styles.safe}>
    <StatusBar style="dark" />
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.top}><View><Text style={styles.brand}>here ·</Text><Text style={styles.kicker}>A little more peace of mind</Text></View>{session && <Pressable onPress={() => supabase?.auth.signOut()}><Text style={styles.link}>Sign out</Text></Pressable>}</View>
        {!session ? <View style={styles.authCard}>
          <Text style={styles.title}>{registering ? 'Create your account' : 'Welcome back'}</Text>
          <Text style={styles.copy}>Plan a journey and let someone you trust know when you expect to arrive.</Text>
          {registering && <Field label="Your name" value={form.name} onChangeText={v => setForm({ ...form, name: v })} />}
          <Field label="Email" value={form.email} onChangeText={v => setForm({ ...form, email: v })} keyboardType="email-address" autoCapitalize="none" />
          <Field label="Password" value={form.password} onChangeText={v => setForm({ ...form, password: v })} secureTextEntry />
          <Primary title={registering ? 'Create account' : 'Continue'} busy={busy} onPress={authenticate} />
          <Pressable onPress={() => setRegistering(!registering)} style={styles.switch}><Text style={styles.link}>{registering ? 'I already have an account' : 'Create an account'}</Text></Pressable>
        </View> : <>
          <View style={styles.heading}><Text style={styles.title}>Your journeys</Text><Text style={styles.copy}>A simple check-in plan for the people who care.</Text></View>
          <Pressable onPress={() => setShowJourneyForm(!showJourneyForm)} style={styles.addButton}><Text style={styles.addText}>{showJourneyForm ? 'Close' : '+  Plan a journey'}</Text></Pressable>
          {showJourneyForm && <View style={styles.card}>
            <Text style={styles.section}>Journey details</Text>
            <Field label="Destination" value={journey.destination} onChangeText={v => setJourney({ ...journey, destination: v })} />
            <View style={styles.mapTools}><Text style={styles.copy}>Tap the map to choose the destination.</Text><Pressable onPress={useCurrentLocation}><Text style={styles.link}>Use my location</Text></Pressable></View>
            <View style={styles.mapFrame}><MapView style={styles.map} region={mapRegion} onRegionChangeComplete={setMapRegion} onPress={selectDestination} showsUserLocation>
              {!!journey.latitude && !!journey.longitude && <Marker coordinate={{ latitude: Number(journey.latitude), longitude: Number(journey.longitude) }} title={journey.destination || 'Destination'} />}
              {origin && <Marker coordinate={origin} title="Journey origin" pinColor={green} />}
            </MapView></View>
            <Text style={styles.coordinates}>{journey.latitude && journey.longitude ? `Destination · ${journey.latitude}, ${journey.longitude}` : 'No destination selected'}{origin ? `\nOrigin · ${origin.latitude.toFixed(5)}, ${origin.longitude.toFixed(5)}` : ''}</Text>
            <Field label="Arrival time (e.g. 2026-11-02 18:30)" value={journey.eta} onChangeText={v => setJourney({ ...journey, eta: v })} />
            <Text style={styles.section}>Trusted contact</Text>
            <Field label="Contact name" value={journey.contact} onChangeText={v => setJourney({ ...journey, contact: v })} />
            <Field label="Contact email" value={journey.contactEmail} onChangeText={v => setJourney({ ...journey, contactEmail: v })} keyboardType="email-address" autoCapitalize="none" />
            <Primary title="Save journey" busy={busy} onPress={createJourney} />
          </View>}
          {journeys.length === 0 ? <View style={styles.empty}><Text style={styles.emptyIcon}>⌁</Text><Text style={styles.section}>No journeys yet</Text><Text style={styles.copy}>Your plans will appear here.</Text></View> : journeys.map(item => <View style={styles.card} key={item.id}><View style={styles.cardHead}><View style={styles.dot} /><Text style={styles.status}>{item.status.replaceAll('_', ' ')}</Text></View><Text style={styles.destination}>{item.destination_label}</Text><Text style={styles.copy}>Arrive by {new Date(item.eta).toLocaleString()}</Text><Text style={styles.contact}>Shared with {item.contact_name}</Text></View>)}
        </>}
      </ScrollView>
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f7f5' }, center: { flex: 1, backgroundColor: '#f5f7f5', justifyContent: 'center', alignItems: 'center', padding: 32 }, page: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 54, maxWidth: 600, width: '100%', alignSelf: 'center' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 36 }, brand: { fontSize: 28, fontWeight: '700', letterSpacing: -1.5, color: green }, kicker: { color: muted, fontSize: 12, marginTop: 2 }, heading: { marginBottom: 22 }, title: { color: ink, fontSize: 27, fontWeight: '700', letterSpacing: -0.7 }, copy: { color: muted, fontSize: 14, lineHeight: 21, marginTop: 7 },
  authCard: { backgroundColor: 'white', borderRadius: 24, padding: 22, shadowColor: '#25352f', shadowOpacity: 0.07, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 3 }, field: { flex: 1, marginTop: 17 }, label: { fontSize: 12, color: muted, marginBottom: 8, marginLeft: 3 }, input: { minHeight: 50, backgroundColor: '#f4f6f4', borderRadius: 15, paddingHorizontal: 15, color: ink, fontSize: 15 },
  primary: { minHeight: 52, borderRadius: 17, backgroundColor: green, alignItems: 'center', justifyContent: 'center', marginTop: 21, shadowColor: green, shadowOpacity: 0.17, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 2 }, primaryText: { color: 'white', fontWeight: '600', fontSize: 15 }, switch: { alignItems: 'center', paddingTop: 19 }, link: { color: green, fontSize: 14, fontWeight: '600' },
  addButton: { backgroundColor: 'white', paddingVertical: 17, borderRadius: 17, alignItems: 'center', marginBottom: 18, shadowColor: '#23352e', shadowOpacity: 0.06, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 2 }, addText: { color: green, fontWeight: '600', fontSize: 15 }, card: { backgroundColor: 'white', borderRadius: 21, padding: 19, marginBottom: 14, shadowColor: '#23352e', shadowOpacity: 0.055, shadowRadius: 15, shadowOffset: { width: 0, height: 5 }, elevation: 2 }, cardHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 11 }, dot: { width: 8, height: 8, borderRadius: 8, backgroundColor: '#54a789', marginRight: 8 }, status: { color: green, fontSize: 11, fontWeight: '700', letterSpacing: 0.6 }, destination: { color: ink, fontWeight: '700', fontSize: 19 }, contact: { color: muted, fontSize: 12, marginTop: 14 }, section: { color: ink, fontWeight: '600', fontSize: 16, marginBottom: 3 }, row: { flexDirection: 'row', gap: 12 }, mapTools: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }, mapFrame: { height: 250, borderRadius: 19, overflow: 'hidden', marginTop: 10, backgroundColor: '#e8efeb' }, map: { flex: 1 }, coordinates: { color: muted, fontSize: 11, lineHeight: 17, marginTop: 8, marginLeft: 3 }, empty: { alignItems: 'center', backgroundColor: 'white', borderRadius: 22, padding: 30, marginTop: 4 }, emptyIcon: { fontSize: 30, color: '#9bbcaf', marginBottom: 9 },
})
