import './config.mjs';
import './db.mjs';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import session from 'express-session';
import exphbs from 'express-handlebars';
import mongoSanitize from 'express-mongo-sanitize';
import bcrypt from 'bcryptjs';
import multer from 'multer'; // for handling file uploads
import fs from 'fs';
import nodemailer from 'nodemailer';

// Create a transporter object using the default SMTP transport
let transporter = nodemailer.createTransport({
  //service: 'gmail',

  host: 'sandbox.smtp.mailtrap.io',  // Replace with your mail server host
  port: 25 ||465||587||2525,                // Common port for SMTP
  // secure: false,            // True for 465, false for other ports
  auth: {
  	user:'7889eca5493886', //process.env.EMAIL,
  	pass:'e828fbfc6b9d2b',
	}
  //auth: 'PLAIN'//process.env.EMAILPASSWORD
  
});


////////////////////////////////////

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const User = mongoose.model('User');
const Content = mongoose.model('Content');
const Message = mongoose.model('Message');
const ChronicDisease=mongoose.model('ChronicDisease');
const ModerationQueue= mongoose.model('ModerationQueue');



const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, './public/images')
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname)
  }
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));
app.engine('hbs', exphbs.engine({ extname: '.hbs', defaultLayout: 'main', layoutsDir: path.join(__dirname, 'views/layouts'), runtimeOptions: {
        allowProtoPropertiesByDefault: true,
        allowProtoMethodsByDefault: true
    }, helpers: {
        removePublic: function (path) {
            return path.replace('public/', '/');
        }
    }}));
app.set('view engine', 'hbs');
app.use(mongoSanitize());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: process.env.SECRET, saveUninitialized: false, resave: false }));
app.use((req, res, next) => {
  res.locals.username = req.session.username;
  res.locals.moderator=false;
  if (req.session.username==process.env.ModeratorUsername){
  	res.locals.contentModerator=true;
  }
  next();
})

app.get('/' , (req,res) =>{
	res.render('home', {layout: 'special'});
});

// User registration and login
app.get('/register', async (req, res) => {
  const diseases = await ChronicDisease.find(); // Fetching diseases from the database
  res.render('register',  {layout: 'special', diseases });
});

app.post('/register', mongoSanitize(), async (req, res) => {
  if (!req.body.termsAccepted) {
    return res.render('register',  {layout: 'special', error: "You must accept the terms and conditions." } );
  }

  try {
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    const newUser = new User({
      username: req.body.username,
      email: req.body.email,
      password: hashedPassword,
      isProfessional: req.body.isProfessional ? true : false,
      credentials: req.body.isProfessional ? {
        diploma: req.body.diploma,
        licenseNumber: req.body.licenseNumber,
        areaOfExpertise: req.body.areaOfExpertise,
        verified: false  // This should be set after verification
      } : null,
      diseases: req.body.diseases
    });

    await newUser.save();
    if (newUser.isProfessional==true){
    	await ModerationQueue.create({userId:newUser._id});
    	return res.send('Your information is being reviewed. You will receive an information one we confirm your profile.')
    }
    else{
    	req.session.username = newUser.username;
    	req.session.userId= newUser._id;
    	return res.redirect('/u/' +req.session.username);
    }


    
    
  } catch (error) {
    return res.status(500).render('register',  { layout: 'special',error: 'Error registering user: ' + error.message });
  }
});

app.get('/moderation', async (req, res) => {
  if (!req.session.username) {
    return res.redirect('/');
  } else if (req.session.username !== process.env.ModeratorUsername) {
    res.redirect('/');
  } else {
    try {
      const usersAwaitingModeration = await ModerationQueue.find()
        .populate({
          path: 'userId',
          select: 'username email credentials -_id' // Adjust the fields as needed
        });

      return res.render('moderation', { users: usersAwaitingModeration });
    } catch (error) {
      console.error('Failed to retrieve moderation queue:', error);
      return res.status(500).send("Failed to retrieve users awaiting moderation.");
    }
  }
});

app.post('/verify-user/:queueId', mongoSanitize(), async (req, res) => {
  try {
    const queueEntry = await ModerationQueue.findById(req.params.queueId).populate('userId');
    queueEntry.userId.credentials.verified = true;
    await queueEntry.userId.save();
    await ModerationQueue.findOneAndDelete({ userId: queueEntry.userId._id });

    let mailOptions = {
      from: 'empal12345678@gmail.com', // sender address
      to: queueEntry.userId.email,
      subject: 'Welcome to Our Site!', // Subject line
      text: `Hello ${queueEntry.userId.username},\n\nThank you for registering at our site. You can now login with the credentials you registered.`, // plain text body
      html: `<b>Hello ${queueEntry.userId.username},</b><br><br>Thank you for registering at our site.` // html body
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.log('Error sending email:', error);
        return res.status(500).send('Could not send confirmation email, please try again.');
      }
      console.log('Confirmation email sent:', info.response); 
      return res.json({ success: true });
    });
  } catch (error) {
    console.error('Error verifying user or sending the email:', error);
    return res.status(500).json({ success: false, message: 'Could not verify user.' });
  }
});


app.get('/login', (req, res) => {
  res.render('login', {layout: 'special'});
});
app.post('/login', mongoSanitize(), async (req, res) => {
  const user = await User.findOne({ username: req.body.username });
  if (user && await bcrypt.compare(req.body.password, user.password)) {
  	if (user.credentials.verified==false){
  		return res.render('login', {  layout:'special', error: 'You have not verified yet as a healthcare professional' });
  	}
  	else{
	    req.session.username = user.username;
	    req.session.userId=user._id;
	    res.redirect('/u/' +req.session.username);
  	}
  } else {
    return res.render('login', { layout: 'special', error: 'Invalid credentials' });
  }
});
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Profile page
app.get('/u/:username', async (req, res) => {
	if (!req.session.username){
		res.redirect('/');
	}
  const user = await User.findOne({ username: req.params.username }).populate('contents');
  if (!user) {
    return res.redirect('/u/'+ req.session.username);
  }
  let isProfessional=false
  if (user.isProfessional==true){
  	isProfessional=true;
  }
  let otherUsername=false;
  if (user.username!=req.session.username){
  	otherUsername=true;
  }
  res.render('profile', { user, isProfessional, otherUsername});
});

// Content creation with image upload
app.get('/content/add', (req, res) => {
	if (!req.session.username){
		res.redirect('/');
	}
  res.render('addContent');
});

app.post('/content/add', upload.single('image'), mongoSanitize(), async (req, res) => {
    if (!req.session.username){
        return res.redirect('/');
    }

    const { title, body, tags } = req.body;
    const imagePath = req.file ? req.file.path : '';
    const diseaseNames = tags.split(',');

    try {
        // Find the disease documents that match the names provided in tags
        const diseases = await ChronicDisease.find({
            name: { $in: diseaseNames }
        });

        // Extract the _id from each disease document
        const diseaseIds = diseases.map(disease => disease._id);

        // Now create the content with the correct disease _ids
        const newContent = new Content({
            title,
            body,
            image: imagePath,
            diseases: diseaseIds
        });

        await newContent.save();
        await User.findByIdAndUpdate(req.session.userId, {
            $push: { contents: newContent }  
        });
        return res.redirect('/u/' + req.session.username);
    } catch (error) {
        console.error('Error creating content:', error);
        return res.status(500).send('Error posting content');
    }
});


// Posting a Comment
app.post('/content/:contentId/comment', mongoSanitize(), async (req, res) => {
  if (!req.session.username) {
    return res.redirect('/');
  }

  try {
    const content = await Content.findById(req.params.contentId);
    if (!content) {
      return res.status(404).send("Post not found.");
    }

    const newComment = {
      commenterId: req.session.userId,
      commenterUsername: req.session.username, 
      text: req.body.commentText
    };

    content.comments.push(newComment);
    await content.save();

    return res.redirect('/personalized-content'); // Redirect back to the content feed
  } catch (error) {
    console.error('Error posting comment:', error);
    return res.status(500).send('Error posting comment');
  }
});

app.get('/terms-and-conditions', (req, res) => {
  res.render('termsProfessional');
});

app.get('/messages', async (req, res) => {
    if (!req.session.username) {
        return res.redirect('/');
    }

    try {
        // Fetch all messages where the current user is either the sender or receiver
        const messages = await Message.find({
            $or: [
                { sender: req.session.userId },
                { receiver: req.session.userId }
            ]
        }).populate('sender receiver').sort({ timestamp: -1 });

        // Group messages by conversation partner
        const conversations = {};
				messages.forEach(message => {
				    
				    const otherUsername = message.sender.username === req.session.username ? message.receiver.username : message.sender.username;
				    if (!conversations[otherUsername]) {
				        conversations[otherUsername] = {
				            partner: message.sender.username === req.session.username ? message.receiver : message.sender,
				            messages: [],
				            lastMessageTime: message.timestamp
				        };
				    }
				    conversations[otherUsername].messages.push(message);
				});

        // Sort conversations by the timestamp of the last message
        const sortedConversations = Object.values(conversations).sort((a, b) => b.lastMessageTime - a.lastMessageTime);

        return res.render('messages', { conversations: sortedConversations });
    } catch (error) {
        console.error('Failed to retrieve messages:', error);
        return res.render('messages', {error: 'failed to retrieve messages'});
    }
});



app.post('/send-message', mongoSanitize(), async (req, res) => {
    if (!req.session.username) {
        res.redirect('/');
        return;
    }

    try {
    		// console.log(req.body.receiverUsername)
    		// console.log(req.body.message)
        const { receiverUsername, message } = req.body;
        if (!receiverUsername || !message) {
            res.render('messages', {error: 'Receiver username and message must not be empty'});
            return;
        }


        const sender = await User.findOne({ username: req.session.username });
        if (!sender) {
            res.render('messages', {error: 'Sender not found'});
            return;
        }

        const receiver = await User.findOne({ username: receiverUsername });
        if (!receiver) {
            res.render('messages', {error: 'Receiver not found'});
            return;
        }

       
        const newMessage = new Message({
            sender: sender._id,
            receiver: receiver._id,
            message,
            timestamp: new Date()
        });


        await newMessage.save();

        return res.redirect('/messages');
    } catch (error) {
        console.error('Failed to send message:', error);
        res.render('messages', {error: 'Failed to send message'});
        return;
    }
});




app.get('/personalized-content', async (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/');
  }

  try {
    // Fetch the user and their disease preferences
    const user = await User.findById(req.session.userId);
    if (!user) {
      return res.status(404).send("User not found.");
    }

    // Use the user's diseases to filter content
    //console.log('lalalal')
    const contents = await Content.find({
      diseases: { $in: user.diseases } // Assuming `tags` in Content documents are stored as disease IDs or names that match user.diseases
    }).populate('comments.commenterId').sort({ timestamp: -1 });

    return res.render('personalizedContent', { contents });
  } catch (error) {
    console.error('Failed to retrieve personalized content:', error);
    return res.status(500).send("Failed to retrieve personalized content.");
  }
});


app.get('/edit-profile', async (req, res) => {
		if (!req.session.username){
			res.redirect('/');
		}
	  const filter = {};
	  if (req.query.tag) {
	    filter.tags = { $in: [req.query.tag] };
	    const contents = await Content.find(filter).populate('comments.commenterUsername');
	  	return res.render('searchContent', { contents });
	  }
	  else{
	  
	    const user = await User.findOne({username: req.session.username}).populate('diseases');
	    const allDiseases = await ChronicDisease.find();
	    
	    // Map through all diseases to mark those that are selected
	    const diseasesWithSelection = allDiseases.map(disease => {
	        return {
	            ...disease.toObject(),
	            isSelected: user.diseases.some(userDisease => userDisease._id.equals(disease._id))
	        };
	    });

	    res.render('edit-profile', { diseases: diseasesWithSelection });
   	}
});

app.post('/update-profile', mongoSanitize(), async (req, res) => {
		if (!req.session.username){
			return res.redirect('/');
		}
    const selectedDiseases = req.body.diseases; // This will be an array of disease IDs
    await User.findOneAndUpdate({username: req.session.username}, { diseases: selectedDiseases, bio:req.body.bio });

    res.redirect('/u/' + req.session.username );
});

app.get('/search-user', async (req, res) => {
	if (!req.session.username){
		res.redirect('/');
	}
	else if (req.query.username){
  const username = req.query.username;
  const user = await User.findOne({ username: username });
	  if (user) {
	    return res.redirect('/u/'+user.username);
	  } else {
	    return res.send("No user found with that username.");
	  }
	 }
	 res.render('searchUsername');
});

app.post('/delete-account', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).send('You must be logged in to delete your account.');
    }

    try {
        const userId = req.session.userId;
        
        
        await Content.deleteMany({ user: userId });
        await Message.deleteMany({receiver:userId});
        await Message.deleteMany({sender:userId});
        await ModerationQueue.deleteMany({userId:userId});
        //await Comment.deleteMany({commenterId:userId});


        // Delete the user account
        await User.findByIdAndDelete(userId);

        // Destroy the session and log out
        req.session.destroy(() => {
            res.clearCookie('connect.sid'); // Adjust according to your session cookie name
            res.redirect('/'); // Redirect to home page or login page
        });
    } catch (error) {
        console.error('Failed to delete account:', error);
        res.status(500).send('Failed to delete the account.');
    }
});

app.post('/search-content', async (req, res) => {
	if(!req.session.username){
		return res.render('/');
	}
  const filter = {};

	try {
      // Find disease IDs where the name matches the tag(s)
      const diseases = await ChronicDisease.find({
        name: { $in: req.body.tag.split(',') } // Assuming multiple tags can be separated by commas
      });

      // Map the found diseases to their IDs
      const diseaseIds = diseases.map(disease => disease._id);

      // Set the filter for contents to include any of these IDs in the diseases array
      filter.diseases = { $in: diseaseIds };
      
      console.log('Filtering contents by disease IDs:', diseaseIds);
    } catch (error) {
      console.error('Error finding diseases:', error);
      return res.status(500).send('Error retrieving content based on tags.');
    }
  
  const contents = await Content.find(filter).populate('comments.commenterUsername');
  res.render('personalizedContent', { contents });
});

// Start server
app.listen(3000, () => console.log('Server running on port 3000'));

export default app;

