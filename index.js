const express = require('express')
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const app = express()
const port = process.env.PORT || 5000;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);


app.use(cors());
app.use(express.json());



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.spwmekn.mongodb.net/?retryWrites=true&w=majority`;


const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

function verifyJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send({ message: 'UnAuthorized Access' });
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'Forbidden Access' })
        }
        req.decoded = decoded;
        next();
        // console.log(decoded) // bar
    });
}

async function run() {
    try {
        await client.connect();
        const serviceCollection = client.db('doctorsPortal').collection('services');
        const bookingCollection = client.db('doctorsPortal').collection('booking');
        const userCollection = client.db('doctorsPortal').collection('users');
        const doctorCollection = client.db('doctorsPortal').collection('doctors');
        const paymentCollection = client.db('doctorsPortal').collection('payments');

        const verifyAdmin = async (req, res, next) => {
            const requester = req.decoded.email;
            const requesterAccount = await userCollection.findOne({ email: requester });
            if (requesterAccount.role === 'admin') {
                next();
            }
            else {
                res.status(403).send({ message: 'forbidden' });
            }

        };

        app.post('/create-payment-intent', async (req, res) => {
            const service = req.body;
            const price = service.price;
            const amount = price * 100;
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'usd',
                payment_method_types: ['card']
            });
            res.send({ clientSecret: paymentIntent.client_secret, })
        });

        app.get('/service', async (req, res) => {
            const query = {};
            const cursor = serviceCollection.find(query).project({ name: 1 });
            const services = await cursor.toArray();
            res.send(services);
        });

        app.get('/user', verifyJWT, async (req, res) => {
            const user = await userCollection.find().toArray();
            res.send(user)
        });

        app.get('/admin/:email', async (req, res) => {
            const email = req.params.email;
            const user = await userCollection.findOne({ email: email });
            const isAdmin = user.role === 'admin';
            res.send({ admin: isAdmin });
        });

        app.get('/available', async (req, res) => {
            const date = req.query.date;

            // step 1: get all services
            const services = await serviceCollection.find().toArray();

            //step 2: get the booking of that day
            const query = { date: date }
            const booking = await bookingCollection.find(query).toArray();

            //step 3: for each service, find bookings for that service
            services.forEach(service => {
                const serviceBooking = booking.filter(b => b.treatment === service.name)
                const booked = serviceBooking.map(s => s.slot);
                // service.booked=booked;
                // service.booked = serviceBooking.map(s => s.slot);
                const available = service.slots.filter(s => !booked.includes(s))
                service.slots = available;
            })
            res.send(services);
        });

        app.get('/booking', verifyJWT, async (req, res) => {
            const patient = req.query.patient;
            const decodedEmail = req.decoded.email;
            if (patient === decodedEmail) {
                const query = { patient: patient };
                const booking = await bookingCollection.find(query).toArray();
                res.send(booking);
            }
            else {
                return res.status(403).send({ message: 'Forbidden Access' })
            }
        });

        app.get('/booking/:id', verifyJWT, async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const result = await bookingCollection.findOne(query);
            res.send(result);
        });

        app.post('/booking', async (req, res) => {
            const booking = req.body;
            const query = { treatment: booking.treatment, date: booking.date, patient: booking.patient }
            const exists = await bookingCollection.findOne(query);
            if (exists) {
                return res.send({ success: false, booking: exists })
            }
            const result = await bookingCollection.insertOne(booking);
            return res.send({ success: true, result });
        });


        app.patch('/booking/:id', verifyJWT, async (req, res) => {
            const id = req.params.id;
            const payment = req.body;
            const filter = { _id: ObjectId(id) };
            const updateDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId,
                }
            };
            const result= await paymentCollection.insertOne(payment);
            const updatedBooking= await bookingCollection.updateOne(filter, updateDoc);
            res.send(updateDoc);

        });

        app.get('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = await doctorCollection.find().toArray();
            res.send(doctor);
        });

        app.post('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorCollection.insertOne(doctor);
            res.send(result);
        });

        app.delete('/doctor/:email', verifyJWT, verifyAdmin, async (req, res) => {
            const email = req.params.email;
            const query = { email: email };
            const result = await doctorCollection.deleteOne(query);
            res.send(result);
        });

        app.delete('/user/:email', verifyJWT, verifyAdmin, async (req, res) => {
            const email = req.params.email;
            const query = { email: email };
            const result = await userCollection.deleteOne(query);
            res.send(result);
        });

        app.put('/user/admin/:email', verifyJWT, verifyAdmin, async (req, res) => {
            const email = req.params.email;
            const filter = { email: email };
            const updateDoc = {
                $set: { role: 'admin' },
            };
            const result = await userCollection.updateOne(filter, updateDoc);
            res.send(result);
        });

        app.put('/user/:email', async (req, res) => {
            const email = req.params.email;
            const user = req.body;
            const filter = { email: email };
            const options = { upsert: true };
            const updateDoc = {
                $set: user,
            };
            const result = await userCollection.updateOne(filter, updateDoc, options);
            const token = jwt.sign({ email: email }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' })
            res.send({ result, token });
        });

    }

    /**
     * API Naming Convention
     * app.get('/booking) // get all booking in this collection, get more than one or by filter
     * app.get('/booking/:id') // get a specific booking
     * app.post('/booking')  // add a new booking
     * app.patch('/booking/:id') // update
     * app.put('/booking/:id') upsert if exists or insert 
     * app.delete('/booking/:id')
    */


    finally {

    }
}
run().catch(console.dir);




app.get('/', (req, res) => {
    res.send('Hello World Doctors Uncle')
})

app.listen(port, () => {
    console.log(`Doctor portal listening on port ${port}`)
})
